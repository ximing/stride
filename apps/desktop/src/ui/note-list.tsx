import { ArrowsDownUp, MagnifyingGlass, X } from '@phosphor-icons/react'
import { observer, raw, useService } from '@rabjs/react'
import { plainText, type StrideNote } from '@stride/core/note'
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { typeSidebarLabel } from '../../../../packages/core/src/types'
import { CommandService } from '../services/command.service'
import { buildNoteListMenu, type ContextMenuEntry } from '../services/context-menu'
import { ListFilterService } from '../services/list-filter.service'
import { sortNotes, virtualWindow, type ListSort, type ListSortKey } from '../services/note-list'
import { NoteListService } from '../services/note-list.service'
import { TabsService } from '../services/tabs.service'
import { VaultService } from '../services/vault.service'
import { ViewsService } from '../services/views.service'
import { ContextMenu } from './context-menu'
import { Mark } from './icon'
import { Menu, MenuContent, MenuItem, MenuTrigger } from './menu'
import { Modal, ModalClose, ModalContent } from './modal'

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

const TYPE_COLORS = new Set(['gray', 'blue', 'teal', 'green', 'orange', 'purple', 'red', 'pink', 'yellow'])

function propertyText(value: StrideNote['properties'][string] | undefined): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value[0] ?? ''
  return ''
}

function typeDocColor(doc: StrideNote): string {
  const key = propertyText(doc.properties._color).trim().toLowerCase()
  return TYPE_COLORS.has(key) ? key : 'gray'
}

interface TypeChipInfo {
  color: string
  label: string
}

/**
 * type-title → chip info map. Derived once per notes change: with 10k notes,
 * per-row `typeDocuments.find` calls turn every scroll frame into O(rows × n).
 */
function buildTypeInfo(vault: VaultService): Map<string, TypeChipInfo> {
  const map = new Map<string, TypeChipInfo>()
  for (const doc of vault.typeDocuments) {
    // The chip label mirrors the sidebar: `_sidebar_label` when set.
    map.set(doc.title, { color: typeDocColor(doc), label: typeSidebarLabel(doc) })
  }
  return map
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

const SORT_LABELS: Record<ListSortKey, Record<ListSort['dir'], string>> = {
  mtime: { desc: 'Modified: newest first', asc: 'Modified: oldest first' },
  title: { asc: 'Title A–Z', desc: 'Title Z–A' },
  created: { desc: 'Created: newest first', asc: 'Created: oldest first' },
}

const SORT_ORDER: { key: ListSortKey; dir: ListSort['dir'] }[] = [
  { key: 'mtime', dir: 'desc' },
  { key: 'mtime', dir: 'asc' },
  { key: 'title', dir: 'asc' },
  { key: 'title', dir: 'desc' },
  { key: 'created', dir: 'desc' },
  { key: 'created', dir: 'asc' },
]

const SortMenu = observer(function SortMenu() {
  const list = useService(NoteListService)
  const views = useService(ViewsService)
  // A view with its own sort wins over the manual `stride:list` sort. Picking a
  // sort here still only writes `stride:list` — the view file changes only via
  // the view editor's Save, never implicitly from the list header.
  const viewSort = views.activeView?.view.sort ?? null
  const effective = viewSort ?? list.sort
  return (
    <Menu>
      <MenuTrigger className="note-list-sort" data-testid="note-list-sort" aria-label="Sort notes">
        <Mark icon={ArrowsDownUp} size={14} />
      </MenuTrigger>
      <MenuContent align="end">
        {viewSort && (
          <div className="menu-hint" data-testid="sort-view-hint">
            Sorting set by view “{views.activeView?.view.name}”
          </div>
        )}
        {SORT_ORDER.map(({ key, dir }) => {
          const active = effective.key === key && effective.dir === dir
          return (
            <MenuItem
              key={`${key}-${dir}`}
              data-testid={`sort-${key}-${dir}`}
              aria-checked={active}
              onSelect={() => list.setSort({ key, dir })}
            >
              <span className="menu-check">{active ? '✓' : ''}</span>
              {SORT_LABELS[key][dir]}
            </MenuItem>
          )
        })}
      </MenuContent>
    </Menu>
  )
})

const BatchBar = observer(function BatchBar() {
  const vault = useService(VaultService)
  const list = useService(NoteListService)
  const types = vault.sidebarTypes
  return (
    <div className="note-list-batch" data-testid="note-list-batch">
      <span className="note-list-batch-count" data-testid="note-list-batch-count">
        {list.selectionCount} selected
      </span>
      <button type="button" data-testid="batch-archive" onClick={() => void list.archiveSelected()}>
        Archive
      </button>
      <Menu open={list.retypeOpen} onOpenChange={(open) => { list.retypeOpen = open }}>
        <MenuTrigger className="note-list-batch-retype" data-testid="batch-retype">
          Type
        </MenuTrigger>
        <MenuContent>
          {types.length === 0 && <MenuItem disabled>No types yet</MenuItem>}
          {types.map((type) => (
            <MenuItem
              key={type.id}
              data-testid={`batch-retype-${type.title}`}
              onSelect={() => void list.retypeSelected(type.title)}
            >
              {typeSidebarLabel(type)}
            </MenuItem>
          ))}
        </MenuContent>
      </Menu>
      <button
        type="button"
        className="note-list-batch-delete"
        data-testid="batch-delete"
        onClick={() => { list.confirmingDelete = true }}
      >
        Delete
      </button>
      <button
        type="button"
        className="note-list-batch-clear"
        data-testid="batch-clear"
        aria-label="Clear selection"
        onClick={() => list.clearSelection()}
      >
        <Mark icon={X} size={13} />
      </button>
    </div>
  )
})

const BatchDeleteModal = observer(function BatchDeleteModal() {
  const list = useService(NoteListService)
  return (
    <Modal open={list.confirmingDelete} onOpenChange={(open) => { list.confirmingDelete = open }}>
      <ModalContent
        title="Delete notes"
        description={`Delete ${list.selectionCount} notes permanently? This cannot be undone.`}
      >
        <button
          type="button"
          data-testid="confirm-delete"
          onClick={() => { void list.deleteSelected() }}
        >
          Delete
        </button>
        <ModalClose data-testid="cancel-delete">Cancel</ModalClose>
      </ModalContent>
    </Modal>
  )
})

interface NoteRowProps {
  note: StrideNote
  dateLabel: string
  typeTitle: string
  typeColor: string
  typeLabel: string
  status: string
  active: boolean
  selected: boolean
  onRowClick: (id: string, mods: { shift: boolean; mod: boolean }) => void
  onRowMenu: (id: string, x: number, y: number) => void
}

// memo keeps scroll re-renders cheap: rows whose props did not change bail out.
const NoteRow = memo(function NoteRow({
  note,
  dateLabel,
  typeTitle,
  typeColor,
  typeLabel,
  status,
  active,
  selected,
  onRowClick,
  onRowMenu,
}: NoteRowProps) {
  return (
    <button
      type="button"
      className="note-list-item"
      data-testid="note-list-item"
      data-note-id={note.id}
      aria-current={active ? 'true' : undefined}
      data-selected={selected ? 'true' : undefined}
      onClick={(event) => onRowClick(note.id, { shift: event.shiftKey, mod: event.metaKey || event.ctrlKey })}
      onContextMenu={(event) => {
        event.preventDefault()
        event.stopPropagation()
        onRowMenu(note.id, event.clientX, event.clientY)
      }}
    >
      <span className="note-list-item-title">{note.title || 'Untitled'}</span>
      <span className="note-list-item-meta">
        <span className="note-list-item-date">{dateLabel}</span>
        {typeTitle !== '' && (
          <span className="note-chip" data-testid="note-chip-type" data-type={typeTitle}>
            <span className={`type-dot type-dot-${typeColor}`} />
            <span className="note-chip-label">{typeLabel}</span>
          </span>
        )}
        {status !== '' && (
          <span className="note-chip note-chip-status" data-testid="note-chip-status">{status}</span>
        )}
        <span className="note-list-item-snippet">{noteSnippet(note)}</span>
      </span>
    </button>
  )
})

/** Default type ('note') gets no chip; everything else does. */
function chipTypeOf(note: StrideNote): string {
  const type = note.type.trim()
  return type !== '' && type.toLowerCase() !== 'note' ? type : ''
}

/** Right-click rename: open the note, then focus/select the stage title input. */
function focusNoteTitle() {
  window.setTimeout(() => {
    const input = document.querySelector<HTMLInputElement>('[data-testid="note-title"]')
    input?.focus()
    input?.select()
  }, 0)
}

function clipboardWrite(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.clipboard?.writeText === 'function'
}

interface RowMenuState {
  x: number
  y: number
  items: ContextMenuEntry[]
}

export const NoteList = observer(function NoteList() {
  const vault = useService(VaultService)
  const listFilter = useService(ListFilterService)
  const list = useService(NoteListService)
  const views = useService(ViewsService)
  const tabs = useService(TabsService)
  const commands = useService(CommandService)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewport, setViewport] = useState(0)
  const [rowMenu, setRowMenu] = useState<RowMenuState | null>(null)

  // Measure the scroll viewport. jsdom has no ResizeObserver/layout, so fall
  // back to a nominal viewport that renders a full window in tests.
  useEffect(() => {
    const element = scrollRef.current
    if (!element) return
    setViewport(element.clientHeight || 600)
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      setViewport(element.clientHeight || 600)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  // Switching filter dimension or sort resets the scroll position (never persisted).
  useEffect(() => {
    const element = scrollRef.current
    if (element) element.scrollTop = 0
    setScrollTop(0)
  }, [vault.listFilter, vault.searchQuery, vault.searchHits, listFilter.query, list.sort, list.scrollEpoch, views.views])

  // Filter + sort only recompute when the underlying data changes, not on
  // scroll. ListFilterService.apply scans raw (non-proxy) notes internally —
  // proxied property reads at 10k notes cost hundreds of ms per keystroke.
  // Reactivity is preserved because every vault mutation replaces `notes`
  // (and `noteMtimes`) by identity, which is a memo dep. `views.views` is the
  // dep for view-definition changes (rename/edit/reorder all replace it).
  const activeView = views.activeView
  const effectiveSort: ListSort = activeView?.view.sort ?? list.sort
  const notes = useMemo(
    () => sortNotes(listFilter.apply(vault.visibleNotes), effectiveSort, raw(vault.noteMtimes)),
    [vault.notes, vault.searchHits, vault.searchQuery, vault.listFilter, listFilter.query, effectiveSort, vault.noteMtimes, views.views],
  )
  const typeInfo = useMemo(() => buildTypeInfo(vault), [vault.notes])
  const title = useMemo(
    () => activeView?.view.name ?? noteListTitle(vault),
    [activeView, vault.searchQuery, vault.searchHits, vault.listFilter, typeInfo, views.views],
  )
  const orderedIds = useMemo(() => notes.map((note) => note.id), [notes])
  const win = virtualWindow(notes.length, scrollTop, viewport)
  const rows = notes.slice(win.start, win.end)
  const emptyText = notes.length > 0
    ? ''
    : listFilter.query.trim() !== ''
      ? `No notes match “${listFilter.query.trim()}”.`
      : 'No notes here.'

  // Right-click selects the row first (menus act on the selection), then the
  // builder decides single vs batch from the resulting selection. Batch items
  // execute through CommandService, so menu, palette, and manifest stay同源.
  function openRowMenu(id: string, x: number, y: number) {
    list.selectForMenu(id)
    const multi = list.selectedIds.length > 1 && list.selectedIds.includes(id)
    const items = buildNoteListMenu(
      { noteId: id, multi, clipboard: clipboardWrite(), commands: commands.commands },
      {
        open: (noteId) => tabs.openNote(noteId),
        rename: (noteId) => {
          tabs.openNote(noteId)
          focusNoteTitle()
        },
        copyWikilink: (noteId) => {
          const title = vault.notes.find((note) => note.id === noteId)?.title ?? ''
          if (title) void navigator.clipboard?.writeText(`[[${title}]]`)
        },
        archive: (noteId) => void vault.archiveNotes([noteId]),
        deleteNote: () => { list.confirmingDelete = true },
        archiveSelected: () => commands.execute('list.archiveSelected'),
        deleteSelected: () => commands.execute('list.deleteSelected'),
        retypeSelected: () => commands.execute('list.retypeSelected'),
      },
    )
    setRowMenu({ x, y, items })
  }

  return (
    <div
      className="note-list"
      data-testid="note-list"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && list.selectionCount > 0) {
          list.clearSelection()
          event.stopPropagation()
        }
      }}
    >
      <header className="note-list-head">
        <h2 className="note-list-title" data-testid="note-list-title">{title}</h2>
        <span className="note-list-count" data-testid="note-list-count">{notes.length}</span>
        <SortMenu />
      </header>
      <ListFilterInput />
      {list.hasMultiSelection && <BatchBar />}
      <div
        className="note-list-items"
        data-testid="note-list-items"
        ref={scrollRef}
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      >
        {emptyText !== '' && <p className="note-list-empty">{emptyText}</p>}
        {win.topPad > 0 && <div className="note-list-spacer" style={{ height: win.topPad }} />}
        {rows.map((note) => {
          const chipType = chipTypeOf(note)
          const chip = chipType !== '' ? typeInfo.get(chipType) : undefined
          return (
            <NoteRow
              key={note.id}
              note={note}
              dateLabel={relativeDay(vault.noteMtimes[note.id] ?? 0, Date.now())}
              typeTitle={chipType}
              typeColor={chip?.color ?? 'gray'}
              typeLabel={chip?.label ?? chipType}
              status={propertyText(note.properties.status).trim()}
              active={vault.activeId === note.id}
              selected={list.isSelected(note.id)}
              onRowClick={(id, mods) => list.clickNote(id, mods, orderedIds)}
              onRowMenu={openRowMenu}
            />
          )
        })}
        {win.bottomPad > 0 && <div className="note-list-spacer" style={{ height: win.bottomPad }} />}
      </div>
      <BatchDeleteModal />
      {rowMenu && (
        <ContextMenu
          x={rowMenu.x}
          y={rowMenu.y}
          items={rowMenu.items}
          onClose={() => setRowMenu(null)}
        />
      )}
    </div>
  )
})

// Row height lives with the pure windowing math; re-exported for tests.
export { NOTE_ROW_HEIGHT } from '../services/note-list'
