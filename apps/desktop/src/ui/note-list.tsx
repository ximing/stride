import { MagnifyingGlass, X } from '@phosphor-icons/react'
import { observer, useService } from '@rabjs/react'
import { plainText, type StrideNote } from '@stride/core/note'
import { typeSidebarLabel } from '../../../../packages/core/src/types'
import { ListFilterService } from '../services/list-filter.service'
import { VaultService } from '../services/vault.service'
import { Mark } from './icon'

/** Body plain text, whitespace-collapsed and truncated for list rows. */
export function noteSnippet(note: StrideNote, maxLength = 96): string {
  const text = plainText(note.doc).replace(/\s+/g, ' ').trim()
  // The title leads the body (H1), so drop a duplicate prefix.
  const body = note.title && text.startsWith(note.title) ? text.slice(note.title.length).trim() : text
  if (body.length <= maxLength) return body
  return `${body.slice(0, maxLength).trimEnd()}…`
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** Compact relative label. Returns '' when no mtime is known. */
export function relativeDay(mtimeMs: number, now: number): string {
  if (!mtimeMs || mtimeMs <= 0) return ''
  const then = new Date(mtimeMs)
  const current = new Date(now)
  const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
  const days = Math.round((startOfDay(current) - startOfDay(then)) / 86_400_000)
  if (days <= 0) return 'Today'
  if (days === 1) return 'Yesterday'
  if (days < 7) return `${days} days ago`
  const sameYear = then.getFullYear() === current.getFullYear()
  return `${then.getDate()} ${MONTHS[then.getMonth()]}${sameYear ? '' : ` ${then.getFullYear()}`}`
}

/** Header label for the current filter dimension. */
export function noteListTitle(vault: VaultService): string {
  if (vault.searchQuery.trim() && vault.searchHits.length > 0) return 'Search results'
  if (vault.listFilter === 'all') return 'All notes'
  if (vault.listFilter === 'inbox') return 'Inbox'
  const typeDoc = vault.typeDocuments.find((note) => note.title === vault.listFilter)
  if (typeDoc) return typeSidebarLabel(typeDoc)
  return vault.listFilter
}

export const ListFilterInput = observer(function ListFilterInput() {
  const listFilter = useService(ListFilterService)
  return (
    <div className="list-filter">
      <Mark icon={MagnifyingGlass} size={14} />
      <input
        className="list-filter-input"
        data-testid="list-filter"
        placeholder="过滤标题或属性"
        value={listFilter.query}
        onChange={(event) => listFilter.setQuery(event.target.value)}
      />
      {listFilter.query.trim() !== '' && (
        <button
          type="button"
          className="list-filter-clear"
          data-testid="list-filter-clear"
          aria-label="清空过滤"
          onClick={() => listFilter.clear()}
        >
          <Mark icon={X} size={13} />
        </button>
      )}
    </div>
  )
})

export const NoteList = observer(function NoteList() {
  const vault = useService(VaultService)
  const listFilter = useService(ListFilterService)
  const notes = listFilter.apply(vault.visibleNotes)
  return (
    <div className="note-list" data-testid="note-list">
      <header className="note-list-head">
        <h2 className="note-list-title" data-testid="note-list-title">{noteListTitle(vault)}</h2>
        <span className="note-list-count" data-testid="note-list-count">{notes.length}</span>
      </header>
      <ListFilterInput />
      <div className="note-list-items">
        {notes.length === 0 && <p className="note-list-empty">No notes here.</p>}
        {notes.map((note) => (
          <button
            key={note.id}
            type="button"
            className="note-list-item"
            data-testid="note-list-item"
            data-note-id={note.id}
            aria-current={vault.activeId === note.id ? 'true' : undefined}
            onClick={() => vault.select(note.id)}
          >
            <span className="note-list-item-title">{note.title || 'Untitled'}</span>
            <span className="note-list-item-meta">
              <span className="note-list-item-date">{relativeDay(vault.noteMtimes[note.id] ?? 0, Date.now())}</span>
              <span className="note-list-item-snippet">{noteSnippet(note)}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  )
})
