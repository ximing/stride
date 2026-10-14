import type { SearchBackend, SearchDocument, SearchQuery } from '@stride/platform'
import type { EmbeddingSettings } from './settings.ts'
import { EmbeddingClient } from './embeddings.ts'

export interface SearchHit {
  id: string
  score: number
  snippet?: string
}

export type { SearchQuery }

export interface NoteIndex {
  dim: number
  lastQuery: SearchQuery | null
  upsert(docs: { id: string; text: string; vector?: number[] }[]): Promise<void>
  remove(ids: string[]): Promise<void>
  search(query: SearchQuery): Promise<SearchHit[]>
  close(): Promise<void>
}

export function noteIndex(backend: SearchBackend, dim: number): NoteIndex {
  const index: NoteIndex = {
    dim,
    lastQuery: null,
    upsert(docs) {
      return backend.upsert(docs)
    },
    remove(ids) {
      return backend.remove(ids)
    },
    async search(query) {
      index.lastQuery = query
      const hits = await backend.search(query)
      return hits.map((hit) => ({ id: hit.id, score: hit.score, snippet: hit.snippet }))
    },
    close() {
      return backend.close()
    },
  }
  return index
}

export interface RankedNotes {
  mode: 'text' | 'hybrid'
  hits: SearchHit[]
}

export async function searchNotes(
  index: Pick<NoteIndex, 'search'>,
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

export interface NoteRebuildOptions {
  batchSize?: number
  onProgress?: (done: number, total: number) => void | Promise<void>
  shouldContinue?: () => boolean
}

export interface NoteRebuilder {
  upsert(docs: SearchDocument[]): Promise<void>
  remove(ids: string[]): Promise<void>
  rebuild(docs: readonly SearchDocument[], options?: NoteRebuildOptions): Promise<{ aborted: boolean }>
}

const REBUILD_BATCH = 50

interface IndexSink {
  upsert(docs: SearchDocument[]): Promise<void>
  remove(ids: string[]): Promise<void>
}

function nextMacrotask(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0)
  })
}

function cloneDocument(doc: SearchDocument): SearchDocument {
  return {
    id: doc.id,
    text: doc.text,
    vector: doc.vector ? doc.vector.slice() : undefined,
  }
}

// Ids written while a rebuild is in flight are left out of later snapshot batches.
// They are already in the sink, and written once more after the snapshot so an
// in-flight batch cannot finish on stale text.
async function drainLive(
  sink: IndexSink,
  live: Map<string, SearchDocument | null>,
  shouldContinue: () => boolean,
): Promise<boolean> {
  while (live.size > 0) {
    if (!shouldContinue()) return false
    const pending = [...live.entries()]
    live.clear()
    const removed: string[] = []
    const upserts: SearchDocument[] = []
    for (const [id, doc] of pending) {
      if (doc === null) removed.push(id)
      else upserts.push(doc)
    }
    if (removed.length > 0) await sink.remove(removed)
    if (!shouldContinue()) return false
    if (upserts.length > 0) await sink.upsert(upserts)
  }
  return shouldContinue()
}

export function noteRebuilder(sink: IndexSink): NoteRebuilder {
  let rebuilding = false
  const live = new Map<string, SearchDocument | null>()

  return {
    async upsert(docs) {
      if (docs.length === 0) return
      await sink.upsert(docs)
      if (!rebuilding) return
      for (const doc of docs) live.set(doc.id, cloneDocument(doc))
    },
    async remove(ids) {
      if (ids.length === 0) return
      await sink.remove(ids)
      if (!rebuilding) return
      for (const id of ids) live.set(id, null)
    },
    async rebuild(docs, options = {}) {
      const shouldContinue = () => options.shouldContinue?.() ?? true
      const batchSize = Math.max(1, Math.floor(options.batchSize ?? REBUILD_BATCH))
      const total = docs.length
      rebuilding = true
      live.clear()
      try {
        if (!shouldContinue()) return { aborted: true }
        await options.onProgress?.(0, total)
        if (!shouldContinue()) return { aborted: true }
        for (let offset = 0; offset < docs.length; offset += batchSize) {
          await nextMacrotask()
          if (!shouldContinue()) return { aborted: true }
          const batch: SearchDocument[] = []
          const end = Math.min(offset + batchSize, docs.length)
          for (let index = offset; index < end; index += 1) {
            const doc = docs[index]
            if (!doc || live.has(doc.id)) continue
            batch.push(doc)
          }
          if (batch.length > 0) await sink.upsert(batch)
          if (!shouldContinue()) return { aborted: true }
          await options.onProgress?.(end, total)
          if (!shouldContinue()) return { aborted: true }
        }
        const drained = await drainLive(sink, live, shouldContinue)
        if (!drained) return { aborted: true }
        return { aborted: false }
      } finally {
        rebuilding = false
        live.clear()
      }
    },
  }
}
