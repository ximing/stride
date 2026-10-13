import { PlatformError } from './error.ts'

export interface SearchDocument {
  id: string
  text: string
  vector?: number[]
}

export interface SearchQuery {
  text: string
  topK: number
  mode: 'text' | 'hybrid'
  vector?: number[]
}

export interface SearchHit {
  id: string
  score: number
  snippet?: string
}

export interface SearchBackend {
  upsert(docs: SearchDocument[]): Promise<void>
  remove(ids: string[]): Promise<void>
  search(query: SearchQuery): Promise<SearchHit[]>
  close(): Promise<void>
}

export interface SearchOpenOptions {
  vaultKey: string
  dim: number
}

export interface SearchBackendOpener {
  open(options: SearchOpenOptions): Promise<SearchBackend>
}

function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
}

function scoreDocument(text: string, terms: string[]): number {
  const counts = new Map<string, number>()
  for (const token of tokenize(text)) counts.set(token, (counts.get(token) ?? 0) + 1)
  let score = 0
  const matched = new Set<string>()
  for (const term of terms) {
    const tf = counts.get(term) ?? 0
    if (tf === 0) continue
    matched.add(term)
    score += 1 + Math.log(1 + tf)
  }
  if (matched.size === 0) return 0
  return score + matched.size
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

function compareName(a: string, b: string): number {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

export class MemorySearchBackend implements SearchBackend {
  private readonly docs = new Map<string, SearchDocument>()
  private closed = false

  async upsert(docs: SearchDocument[]): Promise<void> {
    this.assertOpen()
    for (const doc of docs) {
      this.docs.set(doc.id, {
        id: doc.id,
        text: doc.text,
        vector: doc.vector ? doc.vector.slice() : undefined,
      })
    }
  }

  async remove(ids: string[]): Promise<void> {
    this.assertOpen()
    for (const id of ids) this.docs.delete(id)
  }

  // Text overlap only. Query vectors are ignored so hybrid and text rank the same.
  async search(query: SearchQuery): Promise<SearchHit[]> {
    this.assertOpen()
    const terms = tokenize(query.text)
    if (terms.length === 0) return []
    const hits: SearchHit[] = []
    for (const doc of this.docs.values()) {
      const score = scoreDocument(doc.text, terms)
      if (score <= 0) continue
      hits.push({ id: doc.id, score, snippet: snippetFor(doc.text, terms) })
    }
    hits.sort((a, b) => b.score - a.score || compareName(a.id, b.id))
    const limit = query.topK > 0 ? Math.floor(query.topK) : 0
    return hits.slice(0, limit)
  }

  async close(): Promise<void> {
    this.assertOpen()
    this.closed = true
  }

  private assertOpen(): void {
    if (!this.closed) return
    throw new PlatformError('io', 'Search backend is closed')
  }
}

export function memorySearchOpener(): SearchBackendOpener {
  return {
    // dim and vaultKey belong to persistent indexes. This double keeps neither.
    open(_options: SearchOpenOptions): Promise<SearchBackend> {
      return Promise.resolve(new MemorySearchBackend())
    },
  }
}
