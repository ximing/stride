import { ChevronDown, ChevronRight, FilePlus, FileText, Folder, FolderPlus } from 'lucide-react'
import { observer, useService } from '@rabjs/react'
import { useEffect, useMemo, useState, type DragEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { StrideNote } from '@stride/core/note'
import {
  buildFolderMenu,
  buildFolderNoteMenu,
  buildTreeRootMenu,
  type ContextMenuEntry,
} from '../../services/commands/context-menu'
import { FolderService } from '../../services/vault/folder.service'
import { folderNotesToShow, parentFolder, showFolder, showNoteInFolder } from '../../services/vault/reveal-note'
import { FOLDER_FILTER_PREFIX, VaultService } from '../../services/vault/vault.service'
import { LayoutService } from '../../services/layout/layout.service'
import { ListFilterService } from '../../services/search/list-filter.service'
import { NoteListService } from '../../services/notes/note-list.service'
import { TabsService } from '../../services/notes/tabs.service'
import { focusNoteTitle } from '../note-list/note-list'
import { ContextMenu } from '../overlays/context-menu'
import { Button, IconButton } from '../primitives/button'
import { Tip } from '../primitives/tooltip'
import { EmptyState } from '../primitives/empty-state'
import { Mark } from '../primitives/icon'
import { Input } from '../primitives/input'
import { Modal, ModalClose, ModalContent } from '../primitives/modal'
import { RailGroupHeader } from '../shell/rail-group'

// A vault-scale folder can hold thousands of notes; the tree renders at most
// this many links per folder and summarizes the rest. Keeps sidebar DOM size
// bounded regardless of vault size (the note list column is the full browser).
export const FOLDER_NOTE_RENDER_CAP = 200

function childFolders(paths: string[], parent: string): string[] {
  return paths.filter((path) => parentFolder(path) === parent)
}

function cssAttr(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value)
  return value.replace(/["\\]/g, '\\$&')
}

function allowDrop(event: DragEvent<HTMLElement>) {
  event.preventDefault()
  event.stopPropagation()
}

function clipboardWrite(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.clipboard?.writeText === 'function'
}

interface TreeMenuState {
  x: number
  y: number
  items: ContextMenuEntry[]
}

function NoteLink({
  note,
  active,
  revealed,
  onSelect,
  onMenu,
}: {
  note: StrideNote
  active: boolean
  revealed: boolean
  onSelect: () => void
  onMenu: (id: string, x: number, y: number) => void
}) {
  const className = ['note-link', active ? 'is-active' : '', revealed ? 'is-revealed' : ''].filter(Boolean).join(' ')
  return (
    <button
      type="button"
      data-testid="note-link"
      data-note-id={note.id}
      draggable
      className={className}
      onClick={onSelect}
      onContextMenu={(event) => {
        event.preventDefault()
        event.stopPropagation()
        onMenu(note.id, event.clientX, event.clientY)
      }}
      onDragStart={(event) => {
        event.dataTransfer.setData('text/plain', note.id)
        event.dataTransfer.effectAllowed = 'move'
      }}
    >
      <Mark icon={FileText} size={14} />
      <span className="folder-note-label">{note.title}</span>
    </button>
  )
}

/** Capped note links for one folder level, with a muted overflow summary. */
function FolderNotes({
  notes,
  parent,
  activeId,
  revealedNoteId,
  onSelect,
  onMenu,
}: {
  notes: readonly StrideNote[]
  parent: string
  activeId: string
  revealedNoteId: string
  onSelect: (id: string) => void
  onMenu: (id: string, x: number, y: number) => void
}) {
  const { t } = useTranslation()
  const { shown, hidden } = folderNotesToShow(notes, parent, FOLDER_NOTE_RENDER_CAP, revealedNoteId)
  return (
    <>
      {shown.map((note) => (
        <NoteLink
          key={note.id}
          note={note}
          active={activeId === note.id}
          revealed={revealedNoteId === note.id}
          onSelect={() => onSelect(note.id)}
          onMenu={onMenu}
        />
      ))}
      {hidden > 0 && (
        <p className="folder-overflow" data-testid="folder-overflow">
          {t('folders.more', { count: hidden })}
        </p>
      )}
    </>
  )
}

/**
 * Inline name editor shared by rename and create flows (VSCode idiom): no
 * visible label or confirm button — focuses and selects on mount, Enter
 * commits, Escape cancels, and leaving the field commits.
 */
function InlineNameInput({
  value,
  label,
  testId,
  className,
  onChange,
  onCommit,
  onCancel,
}: {
  value: string
  /** Accessible name only — never rendered, the tree row is the context. */
  label: string
  testId?: string
  className?: string
  onChange: (value: string) => void
  onCommit: () => void
  onCancel: () => void
}) {
  return (
    <Input
      ref={(element) => {
        if (element && document.activeElement !== element) {
          element.focus()
          element.select()
        }
      }}
      className={className}
      data-testid={testId}
      value={value}
      aria-label={label}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          onCommit()
        } else if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          onCancel()
        }
      }}
      onBlur={() => onCommit()}
    />
  )
}

/** Tree-row-shaped inline editor: folder icon + name field, no card chrome. */
function GhostRow({
  label,
  testId,
  value,
  onChange,
  onCommit,
  onCancel,
}: {
  label: string
  testId: string
  value: string
  onChange: (value: string) => void
  onCommit: () => void
  onCancel: () => void
}) {
  return (
    <div className="folder-ghost-row">
      <Mark icon={Folder} size={14} />
      <InlineNameInput
        label={label}
        testId={testId}
        className="folder-inline-input"
        value={value}
        onChange={onChange}
        onCommit={onCommit}
        onCancel={onCancel}
      />
    </div>
  )
}

interface FolderBlockProps {
  path: string
  paths: string[]
  notes: readonly StrideNote[]
  activeId: string
  revealedNoteId: string
  selectedFolder: string
  renaming: string
  draft: string
  creatingIn: string
  createDraft: string
  foldersCollapsed: Record<string, boolean>
  onSelect: (id: string) => void
  onSelectFolder: (path: string) => void
  onNewNote: (path: string) => void
  onDrop: (event: DragEvent<HTMLElement>, destFolder: string) => void
  onStartRename: (path: string) => void
  onDraft: (value: string) => void
  onRename: (path: string) => void
  onCancelRename: () => void
  onFolderMenu: (path: string, x: number, y: number) => void
  onNoteMenu: (id: string, x: number, y: number) => void
  onCreateDraft: (value: string) => void
  onCreateIn: (path: string) => void
  onCancelCreateIn: () => void
  onToggleFolder: (path: string) => void
}

function FolderBlock({
  path,
  paths,
  notes,
  activeId,
  revealedNoteId,
  selectedFolder,
  renaming,
  draft,
  creatingIn,
  createDraft,
  foldersCollapsed,
  onSelect,
  onSelectFolder,
  onNewNote,
  onDrop,
  onStartRename,
  onDraft,
  onRename,
  onCancelRename,
  onFolderMenu,
  onNoteMenu,
  onCreateDraft,
  onCreateIn,
  onCancelCreateIn,
  onToggleFolder,
}: FolderBlockProps) {
  const { t } = useTranslation()
  const label = path.split('/').pop() ?? path
  const renameLabel = `${t('folders.rename')} ${label}`
  const insideLabel = t('folders.newInside', { name: label })
  const selected = selectedFolder === path
  const collapsed = foldersCollapsed[path] === true
  return (
    <div
      className={selected ? 'folder-row is-active' : 'folder-row'}
      data-testid="folder-row"
      data-path={path}
      data-collapsed={collapsed || undefined}
      onDragOver={allowDrop}
      onDrop={(event) => onDrop(event, path)}
      onContextMenu={(event) => {
        event.preventDefault()
        event.stopPropagation()
        onFolderMenu(path, event.clientX, event.clientY)
      }}
    >
      <div className="folder-row-main">
        {/* The toggle borrows the folder icon's slot: it shows the folder
            glyph at rest, a chevron on hover/focus, and a chevron at all
            times while collapsed — no layout shift, no extra indent. */}
        <button
          type="button"
          className="folder-toggle"
          data-testid="folder-toggle"
          data-path={path}
          data-collapsed={collapsed || undefined}
          aria-expanded={!collapsed}
          aria-label={t('folders.toggleFolder', { name: label })}
          onClick={(event) => {
            event.stopPropagation()
            onToggleFolder(path)
          }}
        >
          <span className="folder-toggle-icon"><Mark icon={Folder} size={14} /></span>
          <span className="folder-toggle-chevron"><Mark icon={collapsed ? ChevronRight : ChevronDown} size={14} /></span>
        </button>
        {renaming === path ? (
          <span className="folder-label folder-label-edit">
            <InlineNameInput
              label={renameLabel}
              className="folder-rename-input"
              value={draft}
              onChange={onDraft}
              onCommit={() => onRename(path)}
              onCancel={onCancelRename}
            />
          </span>
        ) : (
          <Tip content={t('folders.showNotes', { name: label })}>
          <button
            type="button"
            className="folder-label"
            data-testid="folder-label"
            aria-current={selected ? 'page' : undefined}
            onClick={() => onSelectFolder(path)}
            onDoubleClick={() => onStartRename(path)}
          >
            <span className="folder-label-text">{label}</span>
          </button>
          </Tip>
        )}
        {renaming !== path && (
          <div className="folder-row-actions">
            <IconButton
              data-testid="folder-new-note"
              icon={FilePlus}
              label={t('folders.newNoteHere')}
              size="sm"
              onClick={() => onNewNote(path)}
            />
          </div>
        )}
      </div>
      {!collapsed && (
        <div className="folder-children">
          {creatingIn === path && (
            <GhostRow
              label={insideLabel}
              testId="folder-child-name"
              value={createDraft}
              onChange={onCreateDraft}
              onCommit={() => onCreateIn(path)}
              onCancel={onCancelCreateIn}
            />
          )}
          {childFolders(paths, path).map((child) => (
            <FolderBlock
              key={child}
              path={child}
              paths={paths}
              notes={notes}
              activeId={activeId}
              revealedNoteId={revealedNoteId}
              selectedFolder={selectedFolder}
              renaming={renaming}
              draft={draft}
              creatingIn={creatingIn}
              createDraft={createDraft}
              foldersCollapsed={foldersCollapsed}
              onSelect={onSelect}
              onSelectFolder={onSelectFolder}
              onNewNote={onNewNote}
              onDrop={onDrop}
              onStartRename={onStartRename}
              onDraft={onDraft}
              onRename={onRename}
              onCancelRename={onCancelRename}
              onFolderMenu={onFolderMenu}
              onNoteMenu={onNoteMenu}
              onCreateDraft={onCreateDraft}
              onCreateIn={onCreateIn}
              onCancelCreateIn={onCancelCreateIn}
              onToggleFolder={onToggleFolder}
            />
          ))}
          <FolderNotes
            notes={notes}
            parent={path}
            activeId={activeId}
            revealedNoteId={revealedNoteId}
            onSelect={onSelect}
            onMenu={onNoteMenu}
          />
        </div>
      )}
    </div>
  )
}

export const FolderTree = observer(function FolderTree() {
  const { t } = useTranslation()
  const vault = useService(VaultService)
  const folderService = useService(FolderService)
  const listFilter = useService(ListFilterService)
  const tabs = useService(TabsService)
  const noteList = useService(NoteListService)
  const layout = useService(LayoutService)
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [renaming, setRenaming] = useState('')
  const [draft, setDraft] = useState('')
  const [creatingIn, setCreatingIn] = useState('')
  const [createDraft, setCreateDraft] = useState('')
  const [deleting, setDeleting] = useState('')
  const [menu, setMenu] = useState<TreeMenuState | null>(null)

  useEffect(() => {
    void folderService.loadFolders()
  }, [folderService, vault.fs, vault.docEpoch])

  function drop(event: DragEvent<HTMLElement>, destFolder: string) {
    event.preventDefault()
    event.stopPropagation()
    const noteId = event.dataTransfer.getData('text/plain')
    if (!noteId) return
    void folderService.moveNote(noteId, destFolder)
  }

  // Blur commits too (InlineNameInput), so clear state before awaiting — a
  // click on the Create button right after the blur must not submit twice.
  async function submitCreate() {
    const folderName = name.trim()
    if (!folderName) {
      setCreating(false)
      return
    }
    setName('')
    setCreating(false)
    await folderService.createFolder(folderName)
    if (vault.error) {
      setName(folderName)
      setCreating(true)
    }
  }

  async function submitCreateIn(path: string) {
    const child = createDraft.trim()
    if (!child) {
      setCreatingIn('')
      return
    }
    setCreateDraft('')
    setCreatingIn('')
    await folderService.createFolder(`${path}/${child}`)
    if (vault.error) {
      setCreateDraft(child)
      setCreatingIn(path)
    }
  }

  function startRename(path: string) {
    setRenaming(path)
    setDraft(path.split('/').pop() ?? path)
  }

  async function commitRename(path: string) {
    const current = path.split('/').pop() ?? path
    const nextName = draft.trim()
    // Empty or unchanged: just close the editor, no disk write.
    if (!nextName || nextName === current) {
      setRenaming('')
      return
    }
    const parent = parentFolder(path)
    const to = parent ? `${parent}/${nextName}` : nextName
    await folderService.renameFolder(path, to)
    if (!vault.error) setRenaming('')
  }

  // Click scopes the note list to the folder's subtree; clicking the active
  // folder again releases the scope back to All.
  function selectFolder(path: string) {
    const key = `${FOLDER_FILTER_PREFIX}${path}`
    vault.setFilter(vault.listFilter === key ? 'all' : key)
  }

  // Right-click menus. Note rows reuse the note-list selection so the shared
  // delete-confirm modal (owned by NoteList) shows the right count — one
  // confirmation flow for every surface.
  function openFolderMenu(path: string, x: number, y: number) {
    const items = buildFolderMenu(
      { path },
      {
        showInFolder: (folder) => showFolder(vault, folder),
        newNoteHere: (folder) => {
          // Creating inside a collapsed folder must surface the new note.
          layout.setFolderCollapsed(folder, false)
          void folderService.createNoteInFolder(folder)
        },
        newFolderInside: (folder) => {
          layout.setFolderCollapsed(folder, false)
          setCreatingIn(folder)
          setCreateDraft('')
        },
        renameFolder: (folder) => startRename(folder),
        deleteFolder: (folder) => setDeleting(folder),
      },
    )
    setMenu({ x, y, items })
  }

  function openNoteMenu(id: string, x: number, y: number) {
    const items = buildFolderNoteMenu(
      { noteId: id, clipboard: clipboardWrite() },
      {
        open: (noteId) => tabs.openNote(noteId),
        rename: (noteId) => {
          tabs.openNote(noteId)
          focusNoteTitle()
        },
        showInFolder: (noteId) => showNoteInFolder(vault, noteId),
        copyWikilink: (noteId) => {
          const title = vault.notes.find((note) => note.id === noteId)?.title ?? ''
          if (title) void navigator.clipboard?.writeText(`[[${title}]]`)
        },
        archive: (noteId) => void vault.archiveNotes([noteId]),
        deleteNote: (noteId) => {
          noteList.selectForMenu(noteId)
          noteList.confirmingDelete = true
        },
      },
    )
    setMenu({ x, y, items })
  }

  function openRootMenu(x: number, y: number) {
    setMenu({ x, y, items: buildTreeRootMenu({ newFolder: () => setCreating(true) }) })
  }

  // Memoized: re-filtering 10k notes per keystroke is only paid when the
  // query or the underlying notes actually change, not on unrelated renders.
  // A folder scope narrows the note-list column only — the tree keeps showing
  // the full vault (search hits still narrow it, as before).
  const notes = useMemo(
    () => {
      const searching = vault.searchHits.length > 0 && vault.searchQuery.trim() !== ''
      const scoped = vault.listFilter.startsWith(FOLDER_FILTER_PREFIX)
      return listFilter.apply(searching || !scoped ? vault.visibleNotes : vault.listedNotes)
    },
    [vault.notes, vault.searchHits, vault.searchQuery, vault.listFilter, listFilter.query],
  )
  const paths = folderService.folders
  const revealedNoteId = layout.revealedNoteId
  const revealedFolderPath = layout.revealedFolderPath
  const revealSeq = layout.revealSeq
  const treeEmpty = paths.length === 0 && notes.length === 0

  useEffect(() => {
    if (revealSeq === 0) return
    const selector = revealedNoteId
      ? `[data-testid="note-link"][data-note-id="${cssAttr(revealedNoteId)}"]`
      : revealedFolderPath
        ? `[data-testid="folder-row"][data-path="${cssAttr(revealedFolderPath)}"]`
        : ''
    if (!selector) return
    const node = document.querySelector<HTMLElement>(selector)
    if (typeof node?.scrollIntoView === 'function') node.scrollIntoView({ block: 'nearest' })
  }, [revealSeq, revealedNoteId, revealedFolderPath])
  const deletingLabel = deleting.split('/').pop() ?? deleting

  return (
    <div
      className="folder-tree"
      data-testid="folder-root"
      onDragOver={allowDrop}
      onDrop={(event) => drop(event, '')}
      onContextMenu={(event) => {
        event.preventDefault()
        openRootMenu(event.clientX, event.clientY)
      }}
    >
      <RailGroupHeader
        title={t('shell.notes')}
        collapsed={layout.railCollapsed.notes}
        onToggle={() => layout.toggleRailSection('notes')}
        testId="rail-group-notes"
        action={
          <IconButton
            icon={FolderPlus}
            label={t('folders.newFolder')}
            size="sm"
            iconSize={14}
            data-testid="new-folder"
            onClick={() => {
              // The ghost row renders in the group body; expand so it is visible.
              layout.setRailSectionCollapsed('notes', false)
              setName('')
              setCreating(true)
            }}
          />
        }
      />
      {!layout.railCollapsed.notes && (
        <div className="rail-group-body">
          {treeEmpty && !creating && (
            <EmptyState
              compact
              title={listFilter.query.trim() !== '' || vault.searchQuery.trim() !== '' ? t('folders.emptyFilter') : t('folders.empty')}
              testId="folder-tree-empty"
            />
          )}
          {creating && (
            <GhostRow
              label={t('folders.name')}
              testId="folder-name"
              value={name}
              onChange={setName}
              onCommit={() => void submitCreate()}
              onCancel={() => setCreating(false)}
            />
          )}
          {childFolders(paths, '').map((path) => (
            <FolderBlock
              key={path}
              path={path}
              paths={paths}
              notes={notes}
              activeId={vault.activeId}
              revealedNoteId={revealedNoteId}
              selectedFolder={vault.listFilter.startsWith(FOLDER_FILTER_PREFIX) ? vault.listFilter.slice(FOLDER_FILTER_PREFIX.length) : ''}
              renaming={renaming}
              draft={draft}
              creatingIn={creatingIn}
              createDraft={createDraft}
              foldersCollapsed={layout.foldersCollapsed}
              onSelect={(id) => tabs.openNote(id)}
              onSelectFolder={selectFolder}
              onNewNote={(folder) => {
                layout.setFolderCollapsed(folder, false)
                void folderService.createNoteInFolder(folder)
              }}
              onDrop={drop}
              onStartRename={startRename}
              onDraft={setDraft}
              onRename={(path) => void commitRename(path)}
              onCancelRename={() => setRenaming('')}
              onFolderMenu={openFolderMenu}
              onNoteMenu={openNoteMenu}
              onCreateDraft={setCreateDraft}
              onCreateIn={(path) => void submitCreateIn(path)}
              onCancelCreateIn={() => setCreatingIn('')}
              onToggleFolder={(path) => layout.toggleFolder(path)}
            />
          ))}
          <FolderNotes
            notes={notes}
            parent=""
            activeId={vault.activeId}
            revealedNoteId={revealedNoteId}
            onSelect={(id) => tabs.openNote(id)}
            onMenu={openNoteMenu}
          />
        </div>
      )}
      <Modal open={deleting !== ''} onOpenChange={(open) => { if (!open) setDeleting('') }}>
        <ModalContent
          title={t('folders.deleteTitle')}
          description={t('folders.deleteBody', { name: deletingLabel })}
        >
          <div className="sd-modal-actions">
            <ModalClose asChild>
              <Button tone="secondary" data-testid="cancel-delete-folder">{t('common.cancel')}</Button>
            </ModalClose>
            <Button
              tone="danger"
              data-testid="confirm-delete-folder"
              onClick={() => {
                void folderService.deleteFolder(deleting)
                setDeleting('')
              }}
            >
              {t('common.delete')}
            </Button>
          </div>
        </ModalContent>
      </Modal>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  )
})
