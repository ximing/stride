import { createRequire } from 'node:module'
import type { EmbeddingSettings } from './settings.ts'
import { EmbeddingClient } from './embeddings.ts'

const require = createRequire(import.meta.url)

interface VaneCollection {
  add(docs: unknown): Promise<unknown>
  flush(): Promise<unknown>
  search(query: unknown): Promise<unknown>
}

interface VaneDb {
  collection(name: string, schema: unknown, opts: unknown): Promise<VaneCollection>
  close(): Promise<unknown>
}

interface VaneModule {
  open(dbPath: string, opts?: Record<string, unknown>): Promise<VaneDb>
}

export interface SearchHit {
  id: string
  score: number
}

export interface SearchQuery {
  text: string
  topK: number
  mode: 'text' | 'hybrid'
  vector?: number[]
}

export interface NoteIndex {
  dim: number
  lastQuery: SearchQuery | null
  upsert(docs: { id: string; text: string; vector?: number[] }[]): Promise<void>
  search(query: SearchQuery): Promise<SearchHit[]>
  close(): Promise<void>
}

function loadVane(): VaneModule {
  const loaded = require('@vane-rs/node') as VaneModule & { default?: VaneModule }
  const api = typeof loaded.open === 'function' ? loaded : loaded.default
  if (!api || typeof api.open !== 'function') {
    throw new Error('@vane-rs/node did not export open()')
  }
  return api
}

function asHits(value: unknown): SearchHit[] {
  if (!Array.isArray(value)) throw new Error('Vane search did not return a list')
  return value.map((item) => {
    const row = item as { id?: unknown; score?: unknown }
    if (typeof row.id !== 'string' || !row.id) throw new Error('Vane hit is missing an id')
    return { id: row.id, score: typeof row.score === 'number' ? row.score : Number(row.score ?? 0) }
  })
}

export async function openNoteIndex(dir: string, dim: number): Promise<NoteIndex> {
  const vane = loadVane()
  const db = await vane.open(dir, { autoCommit: 'off' })
  const col = await db.collection(
    'notes',
    {
      fields: [
        { name: 'body', type: 'text' },
        { name: 'vec', type: 'vector', dim, metric: 'cosine' },
      ],
    },
    { tokenizer: 'jieba' },
  )
  const index: NoteIndex = {
    dim,
    lastQuery: null,
    async upsert(docs) {
      await col.add(
        docs.map((doc) => ({
          id: doc.id,
          text: doc.text,
          vector: doc.vector ?? Array.from({ length: dim }, () => 0),
        })),
      )
      await col.flush()
    },
    async search(query) {
      index.lastQuery = query
      const payload: Record<string, unknown> = {
        text: query.text,
        topK: query.topK,
        mode: query.mode,
      }
      if (query.mode === 'hybrid') {
        if (!query.vector) throw new Error('Hybrid search needs a vector')
        payload.vector = query.vector
      }
      return asHits(await col.search(payload))
    },
    async close() {
      await db.close()
    },
  }
  return index
}

export interface RankedNotes {
  mode: 'text' | 'hybrid'
  hits: SearchHit[]
}

export async function searchNotes(
  index: NoteIndex,
  query: string,
  embedding: EmbeddingSettings | null,
  client: EmbeddingClient,
): Promise<RankedNotes> {
  if (!embedding?.apiKey) {
    const hits = await index.search({ text: query, topK: 8, mode: 'text' })
    return { mode: 'text', hits }
  }
  const [vector] = await client.embed([query], embedding)
  const hits = await index.search({ text: query, topK: 8, mode: 'hybrid', vector })
  return { mode: 'hybrid', hits }
}
