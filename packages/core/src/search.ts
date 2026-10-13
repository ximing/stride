import type { SearchBackend, SearchQuery } from '@stride/platform'
import type { EmbeddingSettings } from './settings.ts'
import { EmbeddingClient } from './embeddings.ts'

export interface SearchHit {
  id: string
  score: number
}

export type { SearchQuery }

export interface NoteIndex {
  dim: number
  lastQuery: SearchQuery | null
  upsert(docs: { id: string; text: string; vector?: number[] }[]): Promise<void>
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
    async search(query) {
      index.lastQuery = query
      const hits = await backend.search(query)
      return hits.map((hit) => ({ id: hit.id, score: hit.score }))
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
