import { has, register, Service } from '@rabjs/react'
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

  apply(notes: readonly StrideNote[]): readonly StrideNote[] {
    return filterNotes(notes, this.query)
  }
}

// Rail tests mount the tree without main.tsx, so the global service must exist on import.
if (!has(ListFilterService)) register(ListFilterService)
