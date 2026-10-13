import { observer, useService } from '@rabjs/react'
import { useEffect, useState, type DragEvent } from 'react'
import type { StrideNote } from '@stride/core/note'
import { FolderService } from '../services/folder.service'
import { VaultService } from '../services/vault.service'

function parentOf(id: string): string {
  const index = id.lastIndexOf('/')
  return index === -1 ? '' : id.slice(0, index)
}

function childFolders(paths: string[], parent: string): string[] {
  return paths.filter((path) => parentOf(path) === parent)
}

function notesIn(notes: StrideNote[], parent: string): StrideNote[] {
  return notes.filter((note) => parentOf(note.id) === parent)
}

function allowDrop(event: DragEvent<HTMLElement>) {
  event.preventDefault()
  event.stopPropagation()
}

function NoteLink({ note, active, onSelect }: { note: StrideNote; active: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      data-testid="note-link"
      data-note-id={note.id}
      draggable
      className={active ? 'active' : ''}
      onClick={onSelect}
      onDragStart={(event) => {
        event.dataTransfer.setData('text/plain', note.id)
        event.dataTransfer.effectAllowed = 'move'
      }}
    >
      {note.title}
    </button>
  )
}

interface FolderBlockProps {
  path: string
  paths: string[]
  notes: StrideNote[]
  activeId: string
  renaming: string
  draft: string
  onSelect: (id: string) => void
  onDrop: (event: DragEvent<HTMLElement>, destFolder: string) => void
  onStartRename: (path: string) => void
  onDraft: (value: string) => void
  onRename: (path: string) => void
  onDelete: (path: string) => void
}

function FolderBlock({
  path,
  paths,
  notes,
  activeId,
  renaming,
  draft,
  onSelect,
  onDrop,
  onStartRename,
  onDraft,
  onRename,
  onDelete,
}: FolderBlockProps) {
  const label = path.split('/').pop() ?? path
  return (
    <div
      className="folder-row"
      data-testid="folder-row"
      data-path={path}
      onDragOver={allowDrop}
      onDrop={(event) => onDrop(event, path)}
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
        {childFolders(paths, path).map((child) => (
          <FolderBlock
            key={child}
            path={child}
            paths={paths}
            notes={notes}
            activeId={activeId}
            renaming={renaming}
            draft={draft}
            onSelect={onSelect}
            onDrop={onDrop}
            onStartRename={onStartRename}
            onDraft={onDraft}
            onRename={onRename}
            onDelete={onDelete}
          />
        ))}
        {notesIn(notes, path).map((note) => (
          <NoteLink key={note.id} note={note} active={activeId === note.id} onSelect={() => onSelect(note.id)} />
        ))}
      </div>
    </div>
  )
}

export const FolderTree = observer(function FolderTree() {
  const vault = useService(VaultService)
  const folderService = useService(FolderService)
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [renaming, setRenaming] = useState('')
  const [draft, setDraft] = useState('')

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

  const notes = vault.visibleNotes
  const paths = folderService.folders

  return (
    <div className="folder-tree" data-testid="folder-root" onDragOver={allowDrop} onDrop={(event) => drop(event, '')}>
      <button type="button" data-testid="new-folder" onClick={() => setCreating(true)}>
        New folder
      </button>
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
          onSelect={(id) => vault.select(id)}
          onDrop={drop}
          onStartRename={startRename}
          onDraft={setDraft}
          onRename={(path) => void commitRename(path)}
          onDelete={(path) => void folderService.deleteFolder(path)}
        />
      ))}
      {notesIn(notes, '').map((note) => (
        <NoteLink key={note.id} note={note} active={vault.activeId === note.id} onSelect={() => vault.select(note.id)} />
      ))}
    </div>
  )
})
