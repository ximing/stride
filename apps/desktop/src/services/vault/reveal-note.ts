import { has, resolve } from '@rabjs/react'
import { LayoutService } from '../layout/layout.service'
import { NoteListService } from '../notes/note-list.service'
import { ListFilterService } from '../search/list-filter.service'
import { SearchPanelService } from '../search/search-panel.service'
import { FOLDER_FILTER_PREFIX } from './note-identity'

/** Directory that contains a note id. Root notes return ''. */
export function parentFolder(id: string): string {
  const index = id.lastIndexOf('/')
  return index === -1 ? '' : id.slice(0, index)
}

/** `box/inner` → `['box', 'box/inner']`. Empty path yields []. */
export function folderChain(path: string): string[] {
  if (!path) return []
  const chain: string[] = []
  let current = ''
  for (const part of path.split('/')) {
    if (!part) continue
    current = current ? `${current}/${part}` : part
    chain.push(current)
  }
  return chain
}

/**
 * Notes rendered under one folder. Past the cap, a revealed note replaces the
 * last visible row so "show in folder" can scroll to it.
 */
export function folderNotesToShow<T extends { id: string }>(
  notes: readonly T[],
  parent: string,
  cap: number,
  revealedNoteId: string,
): { shown: T[]; hidden: number } {
  const inFolder = notes.filter((note) => parentFolder(note.id) === parent)
  if (cap < 1 || inFolder.length <= cap) return { shown: inFolder, hidden: 0 }
  const head = inFolder.slice(0, cap)
  const revealedIndex = revealedNoteId === '' ? -1 : inFolder.findIndex((note) => note.id === revealedNoteId)
  if (revealedIndex < 0 || revealedIndex < cap) {
    return { shown: head, hidden: inFolder.length - cap }
  }
  const revealed = inFolder[revealedIndex]
  if (!revealed) return { shown: head, hidden: inFolder.length - cap }
  return { shown: [...head.slice(0, cap - 1), revealed], hidden: inFolder.length - cap }
}

interface FolderRevealVault {
  clearSearch(): void
  setFilter(filter: string): void
}

interface FolderScopeVault {
  listFilter: string
  setFilter(filter: string): void
}

/**
 * While the note list is scoped to a folder, point it at the folder that
 * contains `noteId`. A root note releases that scope back to All. All, inbox,
 * type, and view filters stay as they are — only a stale directory selection
 * follows the opened note.
 */
export function followNoteParentFolder(vault: FolderScopeVault, noteId: string) {
  if (!noteId || !vault.listFilter.startsWith(FOLDER_FILTER_PREFIX)) return
  const parent = parentFolder(noteId)
  const next = parent ? `${FOLDER_FILTER_PREFIX}${parent}` : 'all'
  if (vault.listFilter === next) return
  vault.setFilter(next)
  if (has(NoteListService)) resolve(NoteListService).requestScrollTo(noteId)
}

/** Drop search and the inline list query so the folder's own notes are visible. */
export function releaseListFilters(vault: FolderRevealVault) {
  vault.clearSearch()
  if (has(ListFilterService)) resolve(ListFilterService).clear()
  if (has(SearchPanelService)) resolve(SearchPanelService).close()
}

/**
 * Expand the folder tree onto `noteId` and, when it lives in a folder, scope
 * the note list to that folder. Root notes stay on the current list filter —
 * the tree root is their folder.
 */
export function showNoteInFolder(vault: FolderRevealVault, noteId: string) {
  releaseListFilters(vault)
  const parent = parentFolder(noteId)
  if (parent) vault.setFilter(`${FOLDER_FILTER_PREFIX}${parent}`)
  resolve(LayoutService).showInTree(folderChain(parent), { noteId })
  if (has(NoteListService)) resolve(NoteListService).requestScrollTo(noteId)
}

/** Scope the note list to a folder and expand that folder in the tree. */
export function showFolder(vault: FolderRevealVault, path: string) {
  releaseListFilters(vault)
  vault.setFilter(`${FOLDER_FILTER_PREFIX}${path}`)
  resolve(LayoutService).showInTree(folderChain(path), { folderPath: path })
}
