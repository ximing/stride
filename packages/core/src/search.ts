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
  degraded: boolean
}

// One query string. A warm local embedder finishes well under this; a stuck socket does not.
export const QUERY_EMBED_TIMEOUT_MS = 10_000

export interface QueryEmbedClock {
  setTimeout: (callback: () => void, ms: number) => unknown
  clearTimeout: (handle: unknown) => void
}

export interface QueryEmbedOptions {
  signal?: AbortSignal
  timeoutMs?: number
  clock?: QueryEmbedClock
}

const hostClock: QueryEmbedClock = {
  setTimeout(callback, ms) {
    return setTimeout(callback, ms)
  },
  clearTimeout(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>)
  },
}

function timeoutError(): Error {
  const error = new Error('Query embedding timed out.')
  error.name = 'TimeoutError'
  return error
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('The operation was aborted.')
}

function linkAbort(controller: AbortController, signal: AbortSignal | undefined): () => void {
  if (!signal) return () => {}
  const onAbort = () => {
    if (!controller.signal.aborted) controller.abort(signal.reason)
  }
  if (signal.aborted) {
    onAbort()
    return () => {}
  }
  signal.addEventListener('abort', onAbort, { once: true })
  return () => {
    signal.removeEventListener('abort', onAbort)
  }
}

// Embed failures, hangs, and cancellation become a text search. index.search errors propagate.
async function queryVector(
  client: EmbeddingClient,
  embedding: EmbeddingSettings,
  query: string,
  options: QueryEmbedOptions = {},
): Promise<number[] | null> {
  const timeoutMs = options.timeoutMs ?? QUERY_EMBED_TIMEOUT_MS
  const clock = options.clock ?? hostClock
  const controller = new AbortController()
  const unlink = linkAbort(controller, options.signal)
  let timer: unknown
  let cleared = false
  const clear = () => {
    if (cleared) return
    cleared = true
    unlink()
    if (timer !== undefined) clock.clearTimeout(timer)
  }
  try {
    if (controller.signal.aborted) return null
    const pending = client.embed([query], embedding, controller.signal)
    const vectors = await new Promise<number[][]>((resolve, reject) => {
      let settled = false
      const fail = (error: unknown) => {
        if (settled) return
        settled = true
        clear()
        reject(error)
      }
      const succeed = (value: number[][]) => {
        if (settled) return
        settled = true
        clear()
        resolve(value)
      }
      const onAbort = () => fail(abortReason(controller.signal))
      pending.then(succeed, fail)
      if (controller.signal.aborted) {
        onAbort()
        return
      }
      controller.signal.addEventListener('abort', onAbort, { once: true })
      timer = clock.setTimeout(() => {
        const error = timeoutError()
        if (!controller.signal.aborted) controller.abort(error)
        fail(error)
      }, timeoutMs)
    })
    const vector = vectors[0]
    if (!vector || vector.length !== embedding.dim) return null
    return vector
  } catch {
    return null
  } finally {
    clear()
  }
}

export async function searchIndex(
  index: Pick<NoteIndex, 'search'>,
  query: string,
  topK: number,
  embedding: EmbeddingSettings | null,
  client: EmbeddingClient,
  vectorGap: number,
  embedOptions?: QueryEmbedOptions,
): Promise<RankedNotes> {
  if (vectorGap > 0 || !embedding?.apiKey) {
    const hits = await index.search({ text: query, topK, mode: 'text' })
    return { mode: 'text', hits, degraded: vectorGap > 0 ? true : false }
  }
  const vector = await queryVector(client, embedding, query, embedOptions)
  if (!vector) {
    const hits = await index.search({ text: query, topK, mode: 'text' })
    return { mode: 'text', hits, degraded: true }
  }
  const hits = await index.search({ text: query, topK, mode: 'hybrid', vector })
  return { mode: 'hybrid', hits, degraded: false }
}

export async function searchNotes(
  index: Pick<NoteIndex, 'search'>,
  query: string,
  embedding: EmbeddingSettings | null,
  client: EmbeddingClient,
  embedOptions?: QueryEmbedOptions,
): Promise<RankedNotes> {
  return searchIndex(index, query, 8, embedding, client, 0, embedOptions)
}

export interface NoteRebuildOptions {
  batchSize?: number
  onProgress?: (done: number, total: number) => void | Promise<void>
  shouldContinue?: () => boolean
}

export interface NoteRebuilder {
  begin(): void
  cancel(): void
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
    begin() {
      if (rebuilding) return
      rebuilding = true
      live.clear()
    },
    cancel() {
      rebuilding = false
      live.clear()
    },
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
      const already = rebuilding
      rebuilding = true
      if (!already) live.clear()
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
