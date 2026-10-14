import { createVane } from '@vane-rs/web'
import type {
  CollectionOptions,
  Doc,
  Hit,
  OpenOptions,
  Schema,
  SearchQuery as VaneSearchQuery,
  VaneWorkerOpts,
  VfsKind,
} from '@vane-rs/web'
import {
  PlatformError,
  type SearchBackend,
  type SearchBackendOpener,
  type SearchDocument,
  type SearchHit,
  type SearchQuery,
} from '@stride/platform'
import { loadPackagedJiebaDict, type JiebaDict } from './dict.ts'

const COLLECTION = 'notes'
const TEXT_FIELD = 'text'

export interface VaneSession {
  open(path?: string, opts?: OpenOptions): Promise<void>
  collection(name: string, schema: Schema, opts?: CollectionOptions): Promise<number>
  add(col: number, docs: Doc[]): Promise<number>
  flush(col: number): Promise<void>
  search(col: number, query: VaneSearchQuery): Promise<Hit[]>
  delete(col: number, ids: string[]): Promise<number>
  close(): Promise<void>
}

export type VaneFactory = (opts?: VaneWorkerOpts) => Promise<VaneSession>

export type JiebaDictLoader = () => Promise<JiebaDict>

function dbPathForVault(vaultKey: string): string {
  if (vaultKey.length === 0) throw new PlatformError('escape', 'vaultKey is empty')
  const bytes = new TextEncoder().encode(vaultKey)
  let hex = ''
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0')
  const path = `stride-${hex}.db`
  if (!/^[A-Za-z0-9._-]+$/.test(path) || path.includes('..')) {
    throw new PlatformError('escape', 'vaultKey is not a safe database name')
  }
  return path
}

// 占位字段是因为 vane 拒绝纯 text schema；T3.5 配上真实 dim 时要重建 collection，不能把占位维度当成用户的 embedding 维度。
const PLACEHOLDER_VECTOR_DIM = 1

function vectorDim(dim: number): number {
  return dim > 0 ? dim : PLACEHOLDER_VECTOR_DIM
}

function schemaFor(dim: number): Schema {
  return {
    fields: [
      { name: TEXT_FIELD, type: 'text' },
      { name: 'vec', type: 'vector', dim: vectorDim(dim), metric: 'cosine' },
    ],
  }
}

function zeroVector(dim: number): number[] {
  return Array.from({ length: dim }, () => 0)
}

function toDocs(docs: SearchDocument[], dim: number): Doc[] {
  const width = vectorDim(dim)
  return docs.map((doc) => {
    const row: Doc = { id: doc.id, text: doc.text }
    row.vector = dim > 0 ? (doc.vector ?? zeroVector(width)) : zeroVector(width)
    return row
  })
}

function termsOf(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
}

function snippetFor(text: string, terms: string[]): string {
  const lower = text.toLowerCase()
  let at = -1
  for (const term of terms) {
    const found = lower.indexOf(term)
    if (found >= 0 && (at < 0 || found < at)) at = found
  }
  if (at < 0) return text.slice(0, 120)
  const start = Math.max(0, at - 40)
  const end = Math.min(text.length, at + 80)
  return text.slice(start, end)
}

function fieldText(fields: Hit['fields']): string | undefined {
  if (!fields) return undefined
  const named = fields[TEXT_FIELD]
  if (typeof named === 'string' && named.length > 0) return named
  let best: string | undefined
  for (const value of Object.values(fields)) {
    if (typeof value !== 'string' || value.length === 0) continue
    if (!best || value.length > best.length) best = value
  }
  return best
}

class VaneSearchBackend implements SearchBackend {
  private closed = false
  private readonly texts = new Map<string, string>()

  constructor(
    private readonly vane: VaneSession,
    private readonly col: number,
    private readonly dim: number,
  ) {}

  async upsert(docs: SearchDocument[]): Promise<void> {
    this.assertOpen()
    await this.vane.add(this.col, toDocs(docs, this.dim))
    await this.vane.flush(this.col)
    for (const doc of docs) this.texts.set(doc.id, doc.text)
  }

  async remove(ids: string[]): Promise<void> {
    this.assertOpen()
    await this.vane.delete(this.col, ids)
    await this.vane.flush(this.col)
    for (const id of ids) this.texts.delete(id)
  }

  // Hybrid with no query vector stays BM25 (`mode: 'text'`). No embedding HTTP.
  async search(query: SearchQuery): Promise<SearchHit[]> {
    this.assertOpen()
    const terms = termsOf(query.text)
    const vector = query.mode === 'hybrid' && query.vector && query.vector.length > 0 ? query.vector : undefined
    if (terms.length === 0 && !vector) return []
    const limit = query.topK > 0 ? Math.floor(query.topK) : 0
    if (limit === 0) return []
    const vaneQuery: VaneSearchQuery = {
      topK: limit,
      mode: vector ? 'hybrid' : 'text',
    }
    if (query.text.length > 0) vaneQuery.text = query.text
    if (vector) vaneQuery.vector = vector
    const hits = await this.vane.search(this.col, vaneQuery)
    return hits.map((hit) => ({
      id: hit.id,
      score: typeof hit.score === 'number' ? hit.score : Number(hit.score ?? 0),
      snippet: snippetFor(fieldText(hit.fields) ?? this.texts.get(hit.id) ?? '', terms),
    }))
  }

  async close(): Promise<void> {
    this.assertOpen()
    this.closed = true
    await this.vane.close()
  }

  private assertOpen(): void {
    if (!this.closed) return
    throw new PlatformError('io', 'Search backend is closed')
  }
}

export function createVaneSearchOpener(
  factory: VaneFactory,
  vfs: VfsKind,
  loadDict: JiebaDictLoader = loadPackagedJiebaDict,
): SearchBackendOpener {
  return {
    async open(options): Promise<SearchBackend> {
      const dbPath = dbPathForVault(options.vaultKey)
      let loaded: JiebaDict
      try {
        loaded = await loadDict()
      } catch (error) {
        if (error instanceof PlatformError) throw error
        const detail = error instanceof Error ? error.message : String(error)
        throw new PlatformError('io', `Failed to load jieba dictionary: ${detail}`)
      }
      if (loaded.dictData.byteLength === 0 || !/^[0-9a-f]{16}$/.test(loaded.dictSha256)) {
        throw new PlatformError('io', 'Jieba dictionary is empty or its sha256 prefix is invalid')
      }
      // createVane transfers the buffer. slice keeps a shared copy usable and sends only these bytes.
      const dictData = loaded.dictData.slice()
      const vane = await factory({ vfs, dbPath, dictData, dictSha256: loaded.dictSha256 })
      try {
        await vane.open(dbPath, { autoCommit: 'off', persistence: 'persistent' })
        const col = await vane.collection(COLLECTION, schemaFor(options.dim), {
          tokenizer: 'jieba',
          autoCommit: 'off',
        })
        return new VaneSearchBackend(vane, col, options.dim)
      } catch (error) {
        await vane.close().catch(() => undefined)
        throw error
      }
    },
  }
}

export function vaneWebSearchOpener(): SearchBackendOpener {
  return createVaneSearchOpener(createVane, 'opfs')
}
