import { canonicalEmbeddingEndpoint } from './search-cache.ts'
import type { EmbeddingSettings } from './settings.ts'

export interface EmbeddingResponse {
  data?: { index?: number; embedding?: number[] }[]
}

export class EmbeddingClient {
  calls = 0
  constructor(private fetchImpl: typeof fetch = fetch) {}

  async embed(texts: string[], settings: EmbeddingSettings, signal?: AbortSignal): Promise<number[][]> {
    if (!settings.apiKey) throw new Error('No embedding key')
    const endpoint = canonicalEmbeddingEndpoint(settings.endpoint)
    if (!endpoint) throw new Error('No embedding endpoint')
    this.calls += 1
    const response = await this.fetchImpl(`${endpoint}/embeddings`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${settings.apiKey}`,
      },
      body: JSON.stringify({ model: settings.model, input: texts }),
      signal,
    })
    if (!response.ok) {
      throw new Error(`Embedding request failed (${response.status})`)
    }
    const json = (await response.json()) as EmbeddingResponse
    const rows = json.data ?? []
    const ordered = [...rows].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    if (ordered.length !== texts.length) {
      throw new Error(`Embedding count mismatch: expected ${texts.length}, got ${ordered.length}`)
    }
    return ordered.map((row, index) => {
      if (!row.embedding || row.embedding.length === 0) {
        throw new Error(`Embedding ${index} was empty`)
      }
      return row.embedding
    })
  }
}
