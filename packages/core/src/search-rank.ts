export interface RankNote {
  id: string
  title: string
  text: string
}

export interface RankHit {
  id: string
  score: number
  snippet?: string
}

export interface RankedHit {
  id: string
  score: number
  snippet: string
  source: 'title' | 'body'
  offset: number
  length: number
}

function snippetAt(text: string, offset: number, length: number): string {
  const start = Math.max(0, offset - 40)
  const end = Math.min(text.length, offset + Math.max(length, 1) + 80)
  return text.slice(start, end)
}

function byScoreThenId(a: RankedHit, b: RankedHit): number {
  if (a.score !== b.score) return b.score - a.score
  if (a.id < b.id) return -1
  if (a.id > b.id) return 1
  return 0
}

export function rankSearch(query: string, notes: RankNote[], bm25: RankHit[], limit = 30): RankedHit[] {
  const trimmed = query.trim()
  if (!trimmed) return []
  const needle = trimmed.toLowerCase()
  const byId = new Map(notes.map((note) => [note.id, note]))
  const bm25ById = new Map(bm25.map((hit) => [hit.id, hit]))
  const titleHits: RankedHit[] = []
  for (const note of notes) {
    const titleAt = note.title.toLowerCase().indexOf(needle)
    if (titleAt < 0) continue
    const bm = bm25ById.get(note.id)
    titleHits.push({
      id: note.id,
      score: 1_000_000 + (bm?.score ?? 0),
      snippet: snippetAt(note.text, titleAt, trimmed.length),
      source: 'title',
      offset: titleAt,
      length: trimmed.length,
    })
  }
  titleHits.sort(byScoreThenId)
  const claimed = new Set(titleHits.map((hit) => hit.id))
  const terms = needle.split(/\s+/).filter((term) => term.length > 0)
  const bodyBest = new Map<string, RankedHit>()
  for (const hit of bm25) {
    if (claimed.has(hit.id)) continue
    const previous = bodyBest.get(hit.id)
    if (previous && previous.score >= hit.score) continue
    const note = byId.get(hit.id)
    const text = note?.text ?? ''
    const lower = text.toLowerCase()
    let offset = -1
    let length = trimmed.length
    for (const term of terms) {
      const found = lower.indexOf(term)
      if (found >= 0 && (offset < 0 || found < offset)) {
        offset = found
        length = term.length
      }
    }
    if (offset < 0) {
      offset = 0
      length = 0
    }
    bodyBest.set(hit.id, {
      id: hit.id,
      score: hit.score,
      snippet: text ? snippetAt(text, offset, length) : (hit.snippet ?? ''),
      source: 'body',
      offset,
      length,
    })
  }
  const bodyHits = [...bodyBest.values()]
  bodyHits.sort(byScoreThenId)
  return [...titleHits, ...bodyHits].slice(0, Math.max(0, limit))
}
