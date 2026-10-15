import { observer, useService } from '@rabjs/react'
import { useEffect, useMemo, useState, type DragEvent } from 'react'
import type { StrideNote } from '@stride/core/note'
import {
  buildFolderMenu,
  buildFolderNoteMenu,
  buildTreeRootMenu,
  type ContextMenuEntry,
} from '../services/context-menu'
import { FolderService } from '../services/folder.service'
import { ListFilterService } from '../services/list-filter.service'
import { NoteListService } from '../services/note-list.service'
import { TabsService } from '../services/tabs.service'
import { VaultService } from '../services/vault.service'
import { ContextMenu } from './context-menu'
import { EmptyState } from './empty-state'
import { Modal, ModalClose, ModalContent } from './modal'

// A vault-scale folder can hold thousands of notes; the tree renders at most
// this many links per folder and summarizes the rest. Keeps sidebar DOM size
// bounded regardless of vault size (the note list column is the full browser).
export const FOLDER_NOTE_RENDER_CAP = 200

function parentOf(id: string): string {
  const index = id.lastIndexOf('/')
  return index === -1 ? '' : id.slice(0, index)
}

function childFolders(paths: string[], parent: string): string[] {
  return paths.filter((path) => parentOf(path) === parent)
}

function notesIn(notes: readonly StrideNote[], parent: string): StrideNote[] {
  return notes.filter((note) => parentOf(note.id) === parent)
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
  onSelect,
  onMenu,
}: {
  note: StrideNote
  active: boolean
  onSelect: () => void
  onMenu: (id: string, x: number, y: number) => void
}) {
  return (
    <button
      type="button"
      data-testid="note-link"
      data-note-id={note.id}
      draggable
      className={active ? 'active' : ''}
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
      {note.title}
    </button>
  )
}

/** Capped note links for one folder level, with a muted overflow summary. */
function FolderNotes({
  notes,
  parent,
  activeId,
  onSelect,
  onMenu,
}: {
  notes: readonly StrideNote[]
  parent: string
  activeId: string
  onSelect: (id: string) => void
  onMenu: (id: string, x: number, y: number) => void
}) {
  const inFolder = notesIn(notes, parent)
  const shown = inFolder.length > FOLDER_NOTE_RENDER_CAP ? inFolder.slice(0, FOLDER_NOTE_RENDER_CAP) : inFolder
  return (
    <>
      {shown.map((note) => (
        <NoteLink
          key={note.id}
          note={note}
          active={activeId === note.id}
          onSelect={() => onSelect(note.id)}
          onMenu={onMenu}
        />
      ))}
      {inFolder.length > shown.length && (
        <p className="folder-overflow" data-testid="folder-overflow">
          … {inFolder.length - shown.length} more notes here
        </p>
      )}
    </>
  )
}

interface FolderBlockProps {
  path: string
  paths: string[]
  notes: readonly StrideNote[]
  activeId: string
  renaming: string
  draft: string
  creatingIn: string
  createDraft: string
  onSelect: (id: string) => void
  onDrop: (event: DragEvent<HTMLElement>, destFolder: string) => void
  onStartRename: (path: string) => void
  onDraft: (value: string) => void
  onRename: (path: string) => void
  onDelete: (path: string) => void
  onFolderMenu: (path: string, x: number, y: number) => void
  onNoteMenu: (id: string, x: number, y: number) => void
  onCreateDraft: (value: string) => void
  onCreateIn: (path: string) => void
}

function FolderBlock({
  path,
  paths,
  notes,
  activeId,
  renaming,
  draft,
  creatingIn,
  createDraft,
  onSelect,
  onDrop,
  onStartRename,
  onDraft,
  onRename,
  onDelete,
  onFolderMenu,
  onNoteMenu,
  onCreateDraft,
  onCreateIn,
}: FolderBlockProps) {
  const label = path.split('/').pop() ?? path
  return (
    <div
      className="folder-row"
      data-testid="folder-row"
      data-path={path}
      onDragOver={allowDrop}
      onDrop={(event) => onDrop(event, path)}
      onContextMenu={(event) => {
        event.preventDefault()
        event.stopPropagation()
        onFolderMenu(path, event.clientX, event.clientY)
      }}
    >
      <div className="folder-row-main">
        {renaming === path ? (
          <input
            className="folder-rename-input"
            value={draft}
            aria-label={`Rename ${label}`}
            onChange={(event) => onDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                onRename(path)
              }
            }}
          />
        ) : (
          <span className="folder-label">{label}</span>
        )}
        <button type="button" data-testid="rename-folder" onClick={() => (renaming === path ? onRename(path) : onStartRename(path))}>
          Rename
        </button>
        <button type="button" data-testid="delete-folder" onClick={() => onDelete(path)}>
          Delete
        </button>
      </div>
      <div className="folder-children">
        {creatingIn === path && (
          <div className="folder-create">
            <input
              data-testid="folder-child-name"
              value={createDraft}
              aria-label={`New folder inside ${label}`}
              onChange={(event) => onCreateDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  onCreateIn(path)
                }
              }}
            />
            <button type="button" data-testid="create-folder-child" onClick={() => onCreateIn(path)}>
              Create
            </button>
          </div>
        )}
        {childFolders(paths, path).map((child) => (
          <FolderBlock
            key={child}
            path={child}
            paths={paths}
            notes={notes}
            activeId={activeId}
            renaming={renaming}
            draft={draft}
            creatingIn={creatingIn}
            createDraft={createDraft}
            onSelect={onSelect}
            onDrop={onDrop}
            onStartRename={onStartRename}
            onDraft={onDraft}
            onRename={onRename}
            onDelete={onDelete}
            onFolderMenu={onFolderMenu}
            onNoteMenu={onNoteMenu}
            onCreateDraft={onCreateDraft}
            onCreateIn={onCreateIn}
          />
        ))}
        <FolderNotes notes={notes} parent={path} activeId={activeId} onSelect={onSelect} onMenu={onNoteMenu} />
      </div>
    </div>
  )
}

export const FolderTree = observer(function FolderTree() {
  const vault = useService(VaultService)
  const folderService = useService(FolderService)
  const listFilter = useService(ListFilterService)
  const tabs = useService(TabsService)
  const noteList = useService(NoteListService)
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

  async function submitCreate() {
    await folderService.createFolder(name)
    if (!vault.error) {
      setName('')
      setCreating(false)
    }
  }

  async function submitCreateIn(path: string) {
    const child = createDraft.trim()
    if (!child) return
    await folderService.createFolder(`${path}/${child}`)
    if (!vault.error) {
      setCreateDraft('')
      setCreatingIn('')
    }
  }

  function startRename(path: string) {
    setRenaming(path)
    setDraft(path.split('/').pop() ?? path)
  }

  async function commitRename(path: string) {
    const parent = parentOf(path)
    const nextName = draft.trim()
    const to = parent ? `${parent}/${nextName}` : nextName
    await folderService.renameFolder(path, to)
    if (!vault.error) setRenaming('')
  }

  // Right-click menus. Note rows reuse the note-list selection so the shared
  // delete-confirm modal (owned by NoteList) shows the right count — one
  // confirmation flow for every surface.
  function openFolderMenu(path: string, x: number, y: number) {
    const items = buildFolderMenu(
      { path },
      {
        newNoteHere: (folder) => void folderService.createNoteInFolder(folder),
        newFolderInside: (folder) => {
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
  const notes = useMemo(
    () => listFilter.apply(vault.visibleNotes),
    [vault.notes, vault.searchHits, vault.searchQuery, vault.listFilter, listFilter.query],
  )
  const paths = folderService.folders
  const treeEmpty = paths.length === 0 && notes.length === 0
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
      <button type="button" data-testid="new-folder" onClick={() => setCreating(true)}>
        New folder
      </button>
      {treeEmpty && (
        <EmptyState
          compact
          title={listFilter.query.trim() !== '' || vault.searchQuery.trim() !== '' ? 'No notes match the current filter.' : 'No notes yet.'}
          testId="folder-tree-empty"
        />
      )}
      {creating && (
        <div className="folder-create">
          <input
            data-testid="folder-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                void submitCreate()
              }
            }}
          />
          <button type="button" data-testid="create-folder" onClick={() => void submitCreate()}>
            Create
          </button>
        </div>
      )}
      {childFolders(paths, '').map((path) => (
        <FolderBlock
          key={path}
          path={path}
          paths={paths}
          notes={notes}
          activeId={vault.activeId}
          renaming={renaming}
          draft={draft}
          creatingIn={creatingIn}
          createDraft={createDraft}
          onSelect={(id) => tabs.openNote(id)}
          onDrop={drop}
          onStartRename={startRename}
          onDraft={setDraft}
          onRename={(path) => void commitRename(path)}
          onDelete={(path) => setDeleting(path)}
          onFolderMenu={openFolderMenu}
          onNoteMenu={openNoteMenu}
          onCreateDraft={setCreateDraft}
          onCreateIn={(path) => void submitCreateIn(path)}
        />
      ))}
      <FolderNotes notes={notes} parent="" activeId={vault.activeId} onSelect={(id) => tabs.openNote(id)} onMenu={openNoteMenu} />
      <Modal open={deleting !== ''} onOpenChange={(open) => { if (!open) setDeleting('') }}>
        <ModalContent
          title="Delete folder"
          description={`Delete folder “${deletingLabel}”? The folder must be empty of notes.`}
        >
          <button
            type="button"
            data-testid="confirm-delete-folder"
            onClick={() => {
              void folderService.deleteFolder(deleting)
              setDeleting('')
            }}
          >
            Delete
          </button>
          <ModalClose data-testid="cancel-delete-folder">Cancel</ModalClose>
        </ModalContent>
      </Modal>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  )
})
