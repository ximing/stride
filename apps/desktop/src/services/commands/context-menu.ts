// Pure context-menu builders: given the surface state and the actions to wire,
// produce the item list (labels, icons, shortcut hints, disabled/danger flags).
// No rabjs/DOM/service dependencies, so every surface's menu — including its
// enabled rules — is unit-testable. Mount points (note list, editor, folder
// tree) only gather state, supply actions, and render <ContextMenu>.
//
// Same-source discipline: items that mirror an appCommandManifest command take
// their label and shortcut hint from that command (`commandRef`), and the mount
// point executes them through CommandService — the menu never duplicates a
// command title or chord by hand. Editor formatting (bold/italic/highlight) is
// TipTap-domain and stays out of the manifest by design; its hints come from
// the toolbar's `editorTools` chords, formatted via formatShortcut.

import {
  Archive,
  Bold,
  Clipboard,
  Copy,
  ExternalLink,
  FilePlus,
  FolderOpen,
  FolderPlus,
  Highlighter,
  Italic,
  Link as LinkIcon,
  NotebookPen,
  Pencil,
  TextSelect,
  Trash2,
  type LucideIcon,
} from 'lucide-react'
import { commandTitle, t } from '../../i18n'
import { formatShortcut, type AppCommand } from './commands'

export interface ContextMenuItem {
  kind: 'item'
  /** Stable id — drives data-testid={`context-menu-item-${id}`}. */
  id: string
  label: string
  icon?: LucideIcon
  /** Pre-formatted chord hint (⌘B / Ctrl+B), rendered right-aligned. */
  shortcut?: string | null
  disabled?: boolean
  danger?: boolean
  /** When set, the row is a checkbox item and shows a check mark while true. */
  checked?: boolean
  onSelect?: () => void
}

export interface ContextMenuSeparator {
  kind: 'separator'
  id: string
}

export type ContextMenuEntry = ContextMenuItem | ContextMenuSeparator

function separator(id: string): ContextMenuSeparator {
  return { kind: 'separator', id }
}

function showInFolderEntry(noteId: string, showInFolder: (noteId: string) => void): ContextMenuItem {
  return {
    kind: 'item',
    id: 'show-in-folder',
    label: t('folders.showInFolder'),
    icon: FolderOpen,
    onSelect: () => showInFolder(noteId),
  }
}

/** Manifest label + formatted chord for a command id. Falls back to the raw id. */
export function commandRef(
  commands: readonly AppCommand[],
  id: string,
): { title: string; shortcut: string | null } {
  const command = commands.find((entry) => entry.id === id)
  return {
    title: command ? commandTitle(command.id, command.title) : id,
    shortcut: command?.shortcut ? formatShortcut(command.shortcut) : null,
  }
}

// ---------------------------------------------------------------------------
// Note list

export interface NoteListMenuInput {
  noteId: string
  /** True when the right-clicked row belongs to a multi (>1) selection. */
  multi: boolean
  /** navigator.clipboard.writeText is available. */
  clipboard: boolean
  commands: readonly AppCommand[]
}

export interface NoteListMenuActions {
  open(noteId: string): void
  rename(noteId: string): void
  copyWikilink(noteId: string): void
  /** Expand the folder tree onto this note and scope the list to its folder. */
  showInFolder(noteId: string): void
  archive(noteId: string): void
  deleteNote(noteId: string): void
  /** Batch paths — the mount point routes these through CommandService. */
  archiveSelected(): void
  deleteSelected(): void
  retypeSelected(): void
}

export function buildNoteListMenu(
  input: NoteListMenuInput,
  actions: NoteListMenuActions,
): ContextMenuEntry[] {
  const { noteId, multi, clipboard, commands } = input
  if (multi) {
    const archive = commandRef(commands, 'list.archiveSelected')
    const retype = commandRef(commands, 'list.retypeSelected')
    const remove = commandRef(commands, 'list.deleteSelected')
    return [
      {
        kind: 'item',
        id: 'archive-selected',
        label: archive.title,
        icon: Archive,
        shortcut: archive.shortcut,
        onSelect: () => actions.archiveSelected(),
      },
      {
        kind: 'item',
        id: 'retype-selected',
        label: retype.title,
        icon: NotebookPen,
        shortcut: retype.shortcut,
        onSelect: () => actions.retypeSelected(),
      },
      separator('batch'),
      {
        kind: 'item',
        id: 'delete-selected',
        label: remove.title,
        icon: Trash2,
        shortcut: remove.shortcut,
        danger: true,
        onSelect: () => actions.deleteSelected(),
      },
    ]
  }
  return [
    {
      kind: 'item',
      id: 'open',
      label: t('folders.open'),
      icon: ExternalLink,
      onSelect: () => actions.open(noteId),
    },
    {
      kind: 'item',
      id: 'rename',
      label: t('folders.rename'),
      icon: Pencil,
      onSelect: () => actions.rename(noteId),
    },
    showInFolderEntry(noteId, actions.showInFolder),
    separator('note-actions'),
    {
      kind: 'item',
      id: 'copy-wikilink',
      label: t('folders.copyWikilink'),
      icon: LinkIcon,
      disabled: !clipboard,
      onSelect: () => actions.copyWikilink(noteId),
    },
    separator('note-danger'),
    {
      kind: 'item',
      id: 'archive',
      label: t('folders.archive'),
      icon: Archive,
      onSelect: () => actions.archive(noteId),
    },
    {
      kind: 'item',
      id: 'delete',
      label: t('folders.delete'),
      icon: Trash2,
      danger: true,
      onSelect: () => actions.deleteNote(noteId),
    },
  ]
}

// ---------------------------------------------------------------------------
// Editor (TipTap domain)

export interface EditorWikilinkTarget {
  target: string
  alias: string
  /** True when the target resolves to an existing note. */
  resolved: boolean
}

export interface EditorMenuInput {
  hasSelection: boolean
  editable: boolean
  /** navigator.clipboard.readText is available (Paste). */
  clipboardRead: boolean
  /** navigator.clipboard.writeText is available (Copy). */
  clipboardWrite: boolean
  /** Wikilink node under the cursor, when the right-click landed on one. */
  wikilink: EditorWikilinkTarget | null
  /** Pre-formatted editing chords from the toolbar's editorTools. */
  shortcuts: { bold: string | null; italic: string | null; highlight: string | null }
}

export interface EditorMenuActions {
  format(name: 'bold' | 'italic' | 'highlight'): void
  link(): void
  copy(): void
  paste(): void
  selectAll(): void
  /** Same behavior as a wikilink click (open, or create-then-open). */
  openLink(target: string): void
  /** Resolved links only: open the target note in its own tab. */
  openLinkInNewTab(target: string): void
  copyWikilink(text: string): void
}

export function wikilinkText(link: { target: string; alias: string }): string {
  return link.alias ? `[[${link.target}|${link.alias}]]` : `[[${link.target}]]`
}

export function buildEditorMenu(
  input: EditorMenuInput,
  actions: EditorMenuActions,
): ContextMenuEntry[] {
  const link = input.wikilink
  if (link) {
    const items: ContextMenuEntry[] = link.resolved
      ? [
          {
            kind: 'item',
            id: 'open-link',
            label: t('menu.openLink'),
            icon: ExternalLink,
            onSelect: () => actions.openLink(link.target),
          },
          {
            kind: 'item',
            id: 'open-link-new-tab',
            label: t('menu.openInTab'),
            icon: FilePlus,
            onSelect: () => actions.openLinkInNewTab(link.target),
          },
        ]
      : [
          {
            kind: 'item',
            id: 'create-and-open',
            label: t('menu.createAndOpen'),
            icon: FilePlus,
            onSelect: () => actions.openLink(link.target),
          },
        ]
    items.push(separator('wikilink'), {
      kind: 'item',
      id: 'copy-wikilink',
      label: t('menu.copyWikilink'),
      icon: Copy,
      disabled: !input.clipboardWrite,
      onSelect: () => actions.copyWikilink(wikilinkText(link)),
    })
    return items
  }
  if (input.hasSelection) {
    const locked = !input.editable
    return [
      {
        kind: 'item',
        id: 'bold',
        label: t('editor.tool.bold'),
        icon: Bold,
        shortcut: input.shortcuts.bold,
        disabled: locked,
        onSelect: () => actions.format('bold'),
      },
      {
        kind: 'item',
        id: 'italic',
        label: t('editor.tool.italic'),
        icon: Italic,
        shortcut: input.shortcuts.italic,
        disabled: locked,
        onSelect: () => actions.format('italic'),
      },
      {
        kind: 'item',
        id: 'highlight',
        label: t('editor.tool.highlight'),
        icon: Highlighter,
        shortcut: input.shortcuts.highlight,
        disabled: locked,
        onSelect: () => actions.format('highlight'),
      },
      {
        kind: 'item',
        id: 'link',
        label: t('editor.tool.link'),
        icon: LinkIcon,
        disabled: locked,
        onSelect: () => actions.link(),
      },
      separator('format'),
      {
        kind: 'item',
        id: 'copy',
        label: t('menu.copy'),
        icon: Copy,
        disabled: !input.clipboardWrite,
        onSelect: () => actions.copy(),
      },
    ]
  }
  return [
    {
      kind: 'item',
      id: 'paste',
      label: t('menu.paste'),
      icon: Clipboard,
      disabled: !input.editable || !input.clipboardRead,
      onSelect: () => actions.paste(),
    },
    {
      kind: 'item',
      id: 'select-all',
      label: t('menu.selectAll'),
      icon: TextSelect,
      onSelect: () => actions.selectAll(),
    },
  ]
}

// ---------------------------------------------------------------------------
// Folder tree

export interface FolderMenuInput {
  path: string
}

export interface FolderMenuActions {
  showInFolder(path: string): void
  newNoteHere(path: string): void
  newFolderInside(path: string): void
  renameFolder(path: string): void
  deleteFolder(path: string): void
}

export function buildFolderMenu(
  input: FolderMenuInput,
  actions: FolderMenuActions,
): ContextMenuEntry[] {
  const { path } = input
  return [
    {
      kind: 'item',
      id: 'show-in-folder',
      label: t('folders.showInFolder'),
      icon: FolderOpen,
      onSelect: () => actions.showInFolder(path),
    },
    separator('folder-show'),
    {
      kind: 'item',
      id: 'new-note-here',
      label: t('folders.newNoteHere'),
      icon: NotebookPen,
      onSelect: () => actions.newNoteHere(path),
    },
    {
      kind: 'item',
      id: 'new-folder-inside',
      label: t('folders.newFolderInside'),
      icon: FolderPlus,
      onSelect: () => actions.newFolderInside(path),
    },
    separator('folder-manage'),
    {
      kind: 'item',
      id: 'rename-folder',
      label: t('folders.rename'),
      icon: Pencil,
      onSelect: () => actions.renameFolder(path),
    },
    {
      kind: 'item',
      id: 'delete-folder',
      label: t('folders.delete'),
      icon: Trash2,
      danger: true,
      onSelect: () => actions.deleteFolder(path),
    },
  ]
}

export interface FolderNoteMenuInput {
  noteId: string
  clipboard: boolean
}

export interface FolderNoteMenuActions {
  open(noteId: string): void
  rename(noteId: string): void
  showInFolder(noteId: string): void
  copyWikilink(noteId: string): void
  archive(noteId: string): void
  deleteNote(noteId: string): void
}

export function buildFolderNoteMenu(
  input: FolderNoteMenuInput,
  actions: FolderNoteMenuActions,
): ContextMenuEntry[] {
  const { noteId, clipboard } = input
  return [
    {
      kind: 'item',
      id: 'open',
      label: t('folders.open'),
      icon: ExternalLink,
      onSelect: () => actions.open(noteId),
    },
    {
      kind: 'item',
      id: 'rename',
      label: t('folders.rename'),
      icon: Pencil,
      onSelect: () => actions.rename(noteId),
    },
    showInFolderEntry(noteId, actions.showInFolder),
    separator('note-actions'),
    {
      kind: 'item',
      id: 'copy-wikilink',
      label: t('folders.copyWikilink'),
      icon: LinkIcon,
      disabled: !clipboard,
      onSelect: () => actions.copyWikilink(noteId),
    },
    separator('note-danger'),
    {
      kind: 'item',
      id: 'archive',
      label: t('folders.archive'),
      icon: Archive,
      onSelect: () => actions.archive(noteId),
    },
    {
      kind: 'item',
      id: 'delete',
      label: t('folders.delete'),
      icon: Trash2,
      danger: true,
      onSelect: () => actions.deleteNote(noteId),
    },
  ]
}

export interface TreeRootMenuActions {
  newFolder(): void
}

/** Right-click on the tree's empty space: only a root-level create makes sense. */
export function buildTreeRootMenu(actions: TreeRootMenuActions): ContextMenuEntry[] {
  return [
    {
      kind: 'item',
      id: 'new-folder',
      label: t('folders.newFolder'),
      icon: FolderPlus,
      onSelect: () => actions.newFolder(),
    },
  ]
}
