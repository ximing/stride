import { Service } from '@rabjs/react'
import { isArchived, type StrideNote } from '@stride/core/note'
import { closeOtherOverlays } from '../platform/overlays'
import { TabsService } from '../notes/tabs.service'
import { VaultService } from '../vault/vault.service'

export const QUICK_OPEN_LIMIT = 50

const EXACT_SCORE = 3_000_000
const SUBSTRING_SCORE = 2_000_000
const SUBSEQUENCE_SCORE = 1_000_000

// Exact title beats a contiguous substring, which always beats an ordered subsequence.
export function scoreTitle(title: string, query: string): number {
  const haystack = title.toLowerCase()
  const needle = query.trim().toLowerCase()
  if (!needle) return 0
  if (haystack === needle) return EXACT_SCORE
  const at = haystack.indexOf(needle)
  if (at >= 0) return SUBSTRING_SCORE - Math.min(at, 8_000) + needle.length
  let from = 0
  let run = 0
  let bestRun = 0
  let start = -1
  for (const char of needle) {
    const found = haystack.indexOf(char, from)
    if (found < 0) return 0
    if (start < 0) start = found
    run = found === from ? run + 1 : 1
    if (run > bestRun) bestRun = run
    from = found + 1
  }
  return SUBSEQUENCE_SCORE + Math.min(bestRun, 200) * 20 - Math.min(start, 4_000)
}

function byTitle(a: StrideNote, b: StrideNote): number {
  return a.title.localeCompare(b.title, 'zh')
}

export function rankQuickOpenNotes(notes: readonly StrideNote[], query: string): StrideNote[] {
  const visible = notes.filter((note) => !isArchived(note))
  const needle = query.trim()
  if (!needle) return [...visible].sort(byTitle)
  return visible
    .map((note) => ({ note, score: scoreTitle(note.title, needle) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || byTitle(a.note, b.note))
    .map((item) => item.note)
}

export function quickOpenResults(notes: readonly StrideNote[], query: string): StrideNote[] {
  return rankQuickOpenNotes(notes, query).slice(0, QUICK_OPEN_LIMIT)
}

export class QuickOpenService extends Service {
  open = false
  query = ''
  selected = 0

  private get vault() {
    return this.resolve(VaultService)
  }

  private get tabs() {
    return this.resolve(TabsService)
  }

  get results(): StrideNote[] {
    return quickOpenResults(this.vault.notes, this.query)
  }

  show() {
    if (this.open) return
    closeOtherOverlays('quickOpen', () => this.close())
    this.query = ''
    this.selected = 0
    this.open = true
  }

  close() {
    this.open = false
    this.query = ''
    this.selected = 0
  }

  setQuery(value: string) {
    if (value === this.query) return
    this.query = value
    this.selected = 0
  }

  move(delta: number) {
    const total = this.results.length
    if (total === 0) return
    const current = Math.min(Math.max(this.selected, 0), total - 1)
    const next = current + delta
    if (next < 0 || next >= total) return
    this.selected = next
  }

  confirm() {
    const items = this.results
    if (items.length === 0) return
    const note = items[Math.min(this.selected, items.length - 1)]
    if (!note) return
    this.choose(note.id)
  }

  choose(id: string) {
    this.tabs.openNote(id)
    this.close()
  }
}
