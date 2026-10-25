import { describe, expect, it, vi } from 'vitest'
import type { AppCommand } from './commands'
import {
  buildEditorMenu,
  buildFolderMenu,
  buildFolderNoteMenu,
  buildNoteListMenu,
  buildTreeRootMenu,
  commandRef,
  wikilinkText,
  type ContextMenuEntry,
  type ContextMenuItem,
  type EditorMenuActions,
  type FolderMenuActions,
  type FolderNoteMenuActions,
  type NoteListMenuActions,
} from './context-menu'

const COMMANDS: AppCommand[] = [
  { id: 'list.archiveSelected', title: 'Archive Selected Notes', section: 'List', enabledWhen: 'hasListSelection' },
  { id: 'list.deleteSelected', title: 'Delete Selected Notes…', section: 'List', enabledWhen: 'hasListSelection' },
  { id: 'list.retypeSelected', title: 'Change Type of Selected Notes…', section: 'List', enabledWhen: 'hasListSelection' },
  { id: 'file.newNote', title: 'New Note', shortcut: 'Mod+N', section: 'File', enabledWhen: 'vaultReady' },
]

function itemIds(entries: ContextMenuEntry[]): string[] {
  return entries.map((entry) => (entry.kind === 'separator' ? '|' : entry.id))
}

function item(entries: ContextMenuEntry[], id: string): ContextMenuItem {
  const found = entries.find((entry) => entry.kind === 'item' && entry.id === id)
  if (!found || found.kind !== 'item') throw new Error(`missing item ${id}`)
  return found
}

function noteListActions(): NoteListMenuActions & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    open: (id) => calls.push(`open:${id}`),
    rename: (id) => calls.push(`rename:${id}`),
    showInFolder: (id) => calls.push(`show:${id}`),
    copyWikilink: (id) => calls.push(`copy:${id}`),
    archive: (id) => calls.push(`archive:${id}`),
    deleteNote: (id) => calls.push(`delete:${id}`),
    archiveSelected: () => calls.push('archiveSelected'),
    deleteSelected: () => calls.push('deleteSelected'),
    retypeSelected: () => calls.push('retypeSelected'),
  }
}

describe('commandRef', () => {
  it('reads title and null shortcut from the manifest command', () => {
    expect(commandRef(COMMANDS, 'list.archiveSelected')).toEqual({ title: 'Archive Selected Notes', shortcut: null })
  })

  it('formats the chord when the command has one', () => {
    const ref = commandRef(COMMANDS, 'file.newNote')
    expect(ref.title).toBe('New Note')
    expect(ref.shortcut).toContain('N')
  })

  it('falls back to the raw id for unknown commands', () => {
    expect(commandRef(COMMANDS, 'nope').title).toBe('nope')
  })
})

describe('buildNoteListMenu', () => {
  it('builds the single-note menu in order', () => {
    const actions = noteListActions()
    const entries = buildNoteListMenu(
      { noteId: 'a', multi: false, clipboard: true, commands: COMMANDS },
      actions,
    )
    expect(itemIds(entries)).toEqual(['open', 'rename', 'show-in-folder', '|', 'copy-wikilink', '|', 'archive', 'delete'])
    expect(item(entries, 'delete').danger).toBe(true)
    expect(item(entries, 'copy-wikilink').disabled).toBeFalsy()
  })

  it('disables Copy Wikilink without a clipboard', () => {
    const entries = buildNoteListMenu(
      { noteId: 'a', multi: false, clipboard: false, commands: COMMANDS },
      noteListActions(),
    )
    expect(item(entries, 'copy-wikilink').disabled).toBe(true)
  })

  it('routes single-note actions with the note id', () => {
    const actions = noteListActions()
    const entries = buildNoteListMenu(
      { noteId: 'note-1', multi: false, clipboard: true, commands: COMMANDS },
      actions,
    )
    item(entries, 'open').onSelect?.()
    item(entries, 'rename').onSelect?.()
    item(entries, 'show-in-folder').onSelect?.()
    item(entries, 'copy-wikilink').onSelect?.()
    item(entries, 'archive').onSelect?.()
    item(entries, 'delete').onSelect?.()
    expect(actions.calls).toEqual([
      'open:note-1',
      'rename:note-1',
      'show:note-1',
      'copy:note-1',
      'archive:note-1',
      'delete:note-1',
    ])
  })

  it('builds the batch menu from manifest titles for multi-selections', () => {
    const actions = noteListActions()
    const entries = buildNoteListMenu(
      { noteId: 'a', multi: true, clipboard: true, commands: COMMANDS },
      actions,
    )
    expect(itemIds(entries)).toEqual(['archive-selected', 'retype-selected', '|', 'delete-selected'])
    expect(item(entries, 'archive-selected').label).toBe('Archive Selected Notes')
    expect(item(entries, 'retype-selected').label).toBe('Change Type of Selected Notes…')
    expect(item(entries, 'delete-selected').label).toBe('Delete Selected Notes…')
    expect(item(entries, 'delete-selected').danger).toBe(true)
    item(entries, 'archive-selected').onSelect?.()
    item(entries, 'retype-selected').onSelect?.()
    item(entries, 'delete-selected').onSelect?.()
    expect(actions.calls).toEqual(['archiveSelected', 'retypeSelected', 'deleteSelected'])
  })
})

function editorActions(): EditorMenuActions & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    format: (name) => calls.push(`format:${name}`),
    link: () => calls.push('link'),
    copy: () => calls.push('copy'),
    paste: () => calls.push('paste'),
    selectAll: () => calls.push('selectAll'),
    openLink: (target) => calls.push(`open:${target}`),
    openLinkInNewTab: (target) => calls.push(`openNew:${target}`),
    copyWikilink: (text) => calls.push(`copy:${text}`),
  }
}

const SHORTCUTS = { bold: '⌘B', italic: '⌘I', highlight: '⌘⇧H' }

describe('buildEditorMenu', () => {
  it('builds the selection menu with format hints', () => {
    const actions = editorActions()
    const entries = buildEditorMenu(
      {
        hasSelection: true,
        editable: true,
        clipboardRead: true,
        clipboardWrite: true,
        wikilink: null,
        shortcuts: SHORTCUTS,
      },
      actions,
    )
    expect(itemIds(entries)).toEqual(['bold', 'italic', 'highlight', 'link', '|', 'copy'])
    expect(item(entries, 'bold').shortcut).toBe('⌘B')
    expect(item(entries, 'highlight').shortcut).toBe('⌘⇧H')
    item(entries, 'bold').onSelect?.()
    item(entries, 'highlight').onSelect?.()
    item(entries, 'copy').onSelect?.()
    expect(actions.calls).toEqual(['format:bold', 'format:highlight', 'copy'])
  })

  it('disables format items when the editor is read-only and copy without a clipboard', () => {
    const entries = buildEditorMenu(
      {
        hasSelection: true,
        editable: false,
        clipboardRead: false,
        clipboardWrite: false,
        wikilink: null,
        shortcuts: SHORTCUTS,
      },
      editorActions(),
    )
    expect(item(entries, 'bold').disabled).toBe(true)
    expect(item(entries, 'italic').disabled).toBe(true)
    expect(item(entries, 'highlight').disabled).toBe(true)
    expect(item(entries, 'link').disabled).toBe(true)
    expect(item(entries, 'copy').disabled).toBe(true)
  })

  it('builds the caret menu (paste/select-all) with paste gating', () => {
    const actions = editorActions()
    const entries = buildEditorMenu(
      {
        hasSelection: false,
        editable: true,
        clipboardRead: true,
        clipboardWrite: true,
        wikilink: null,
        shortcuts: SHORTCUTS,
      },
      actions,
    )
    expect(itemIds(entries)).toEqual(['paste', 'select-all'])
    expect(item(entries, 'paste').disabled).toBeFalsy()
    item(entries, 'paste').onSelect?.()
    item(entries, 'select-all').onSelect?.()
    expect(actions.calls).toEqual(['paste', 'selectAll'])

    const noClipboard = buildEditorMenu(
      {
        hasSelection: false,
        editable: true,
        clipboardRead: false,
        clipboardWrite: false,
        wikilink: null,
        shortcuts: SHORTCUTS,
      },
      editorActions(),
    )
    expect(item(noClipboard, 'paste').disabled).toBe(true)

    const readOnly = buildEditorMenu(
      {
        hasSelection: false,
        editable: false,
        clipboardRead: true,
        clipboardWrite: true,
        wikilink: null,
        shortcuts: SHORTCUTS,
      },
      editorActions(),
    )
    expect(item(readOnly, 'paste').disabled).toBe(true)
    expect(item(readOnly, 'select-all').disabled).toBeUndefined()
  })

  it('builds the resolved wikilink menu', () => {
    const actions = editorActions()
    const entries = buildEditorMenu(
      {
        hasSelection: false,
        editable: true,
        clipboardRead: true,
        clipboardWrite: true,
        wikilink: { target: 'Alpha', alias: '', resolved: true },
        shortcuts: SHORTCUTS,
      },
      actions,
    )
    expect(itemIds(entries)).toEqual(['open-link', 'open-link-new-tab', '|', 'copy-wikilink'])
    item(entries, 'open-link').onSelect?.()
    item(entries, 'open-link-new-tab').onSelect?.()
    item(entries, 'copy-wikilink').onSelect?.()
    expect(actions.calls).toEqual(['open:Alpha', 'openNew:Alpha', 'copy:[[Alpha]]'])
  })

  it('builds the unresolved wikilink menu and copies aliased text', () => {
    const actions = editorActions()
    const entries = buildEditorMenu(
      {
        hasSelection: false,
        editable: true,
        clipboardRead: true,
        clipboardWrite: true,
        wikilink: { target: 'Ghost', alias: 'G', resolved: false },
        shortcuts: SHORTCUTS,
      },
      actions,
    )
    expect(itemIds(entries)).toEqual(['create-and-open', '|', 'copy-wikilink'])
    item(entries, 'create-and-open').onSelect?.()
    item(entries, 'copy-wikilink').onSelect?.()
    expect(actions.calls).toEqual(['open:Ghost', 'copy:[[Ghost|G]]'])
  })

  it('disables wikilink copy without a clipboard', () => {
    const entries = buildEditorMenu(
      {
        hasSelection: false,
        editable: true,
        clipboardRead: false,
        clipboardWrite: false,
        wikilink: { target: 'Alpha', alias: '', resolved: true },
        shortcuts: SHORTCUTS,
      },
      editorActions(),
    )
    expect(item(entries, 'copy-wikilink').disabled).toBe(true)
  })
})

describe('wikilinkText', () => {
  it('renders plain and aliased forms', () => {
    expect(wikilinkText({ target: 'Alpha', alias: '' })).toBe('[[Alpha]]')
    expect(wikilinkText({ target: 'Alpha', alias: 'A' })).toBe('[[Alpha|A]]')
  })
})

describe('buildFolderMenu', () => {
  it('builds the folder menu and routes the path', () => {
    const calls: string[] = []
    const actions: FolderMenuActions = {
      showInFolder: (path) => calls.push(`show:${path}`),
      newNoteHere: (path) => calls.push(`note:${path}`),
      newFolderInside: (path) => calls.push(`folder:${path}`),
      renameFolder: (path) => calls.push(`rename:${path}`),
      deleteFolder: (path) => calls.push(`delete:${path}`),
    }
    const entries = buildFolderMenu({ path: 'box/inner' }, actions)
    expect(itemIds(entries)).toEqual(['show-in-folder', '|', 'new-note-here', 'new-folder-inside', '|', 'rename-folder', 'delete-folder'])
    expect(item(entries, 'show-in-folder').label).toBe('Show in Folder')
    expect(item(entries, 'delete-folder').danger).toBe(true)
    for (const id of ['show-in-folder', 'new-note-here', 'new-folder-inside', 'rename-folder', 'delete-folder']) {
      item(entries, id).onSelect?.()
    }
    expect(calls).toEqual(['show:box/inner', 'note:box/inner', 'folder:box/inner', 'rename:box/inner', 'delete:box/inner'])
  })
})

describe('buildFolderNoteMenu', () => {
  it('builds the note-in-tree menu with clipboard gating', () => {
    const calls: string[] = []
    const actions: FolderNoteMenuActions = {
      open: (id) => calls.push(`open:${id}`),
      rename: (id) => calls.push(`rename:${id}`),
      showInFolder: (id) => calls.push(`show:${id}`),
      copyWikilink: (id) => calls.push(`copy:${id}`),
      archive: (id) => calls.push(`archive:${id}`),
      deleteNote: (id) => calls.push(`delete:${id}`),
    }
    const entries = buildFolderNoteMenu({ noteId: 'n1', clipboard: true }, actions)
    expect(itemIds(entries)).toEqual(['open', 'rename', 'show-in-folder', '|', 'copy-wikilink', '|', 'archive', 'delete'])
    for (const id of ['open', 'rename', 'show-in-folder', 'copy-wikilink', 'archive', 'delete']) item(entries, id).onSelect?.()
    expect(calls).toEqual(['open:n1', 'rename:n1', 'show:n1', 'copy:n1', 'archive:n1', 'delete:n1'])

    const noClipboard = buildFolderNoteMenu({ noteId: 'n1', clipboard: false }, actions)
    expect(item(noClipboard, 'copy-wikilink').disabled).toBe(true)
  })
})

describe('buildTreeRootMenu', () => {
  it('offers only a root-level new folder', () => {
    const newFolder = vi.fn()
    const entries = buildTreeRootMenu({ newFolder })
    expect(itemIds(entries)).toEqual(['new-folder'])
    item(entries, 'new-folder').onSelect?.()
    expect(newFolder).toHaveBeenCalledTimes(1)
  })
})
