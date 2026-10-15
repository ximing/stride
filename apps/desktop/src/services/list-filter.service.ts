import { has, raw, register, Service } from '@rabjs/react'
import type { StrideNote } from '@stride/core/note'
import { filterNotes } from './list-filter'

export class ListFilterService extends Service {
  query = ''

  setQuery(value: string) {
    this.query = value
  }

  clear() {
    this.query = ''
  }

  /**
   * Apply the inline query. Reads run on raw (non-proxy) notes: at 10k notes,
   * proxied property scans cost hundreds of ms per keystroke while raw reads
   * are single-digit ms. Callers must key their memoization on the notes-array
   * identity (every vault mutation replaces it), not on per-note tracking.
   */
  apply(notes: readonly StrideNote[]): readonly StrideNote[] {
    if (!this.query.trim()) return notes
    return filterNotes(notes.map((note) => raw(note)), this.query)
  }
}

// Rail tests mount the tree without main.tsx, so the global service must exist on import.
if (!has(ListFilterService)) register(ListFilterService)
