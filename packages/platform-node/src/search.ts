import { createRequire } from 'node:module'
import type { SearchBackend, SearchDocument, SearchHit, SearchQuery } from '@stride/platform'

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

export async function openVaneSearch(dir: string, dim: number): Promise<SearchBackend> {
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
  return {
    async upsert(docs: SearchDocument[]) {
      await col.add(
        docs.map((doc) => ({
          id: doc.id,
          text: doc.text,
          vector: doc.vector ?? Array.from({ length: dim }, () => 0),
        })),
      )
      await col.flush()
    },
    async remove() {
      throw new Error('Vane remove is not used by the legacy server')
    },
    async search(query: SearchQuery) {
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
}
