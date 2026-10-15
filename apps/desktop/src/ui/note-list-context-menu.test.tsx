import { has, register, resolve } from '@rabjs/react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createVaultNote } from '../../../../packages/core/src/vault'
import { ListFilterService } from '../services/list-filter.service'
import { DEFAULT_LIST_SORT } from '../services/note-list'
import { NoteListService } from '../services/note-list.service'
import { VaultService } from '../services/vault.service'
import { NoteList } from './note-list'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
let host: HTMLElement | undefined

function useMemoryFixture() {
  window.history.replaceState(null, '', '/?fixture=memory')
}

async function mountNoteList(): Promise<{ vault: VaultService; list: NoteListService }> {
  useMemoryFixture()
  vi.stubGlobal('showDirectoryPicker', vi.fn())
  register(VaultService)
  if (!has(ListFilterService)) register(ListFilterService)
  resolve(ListFilterService).clear()
  const list = resolve(NoteListService)
  list.clearSelection()
  list.confirmingDelete = false
  list.sort = { ...DEFAULT_LIST_SORT }
  const vault = resolve(VaultService)
  vault.cancelPending()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root?.render(<NoteList />)
  })
  await act(async () => {
    await vault.openFromDraft()
  })
  return { vault, list }
}

async function addNote(vault: VaultService, title: string): Promise<string> {
  let id = ''
  await act(async () => {
    const note = await createVaultNote(vault.fs!, title)
    vault.notes = [note, ...vault.notes]
    id = note.id
  })
  return id
}

function rightClickRow(id: string) {
  const row = host!.querySelector<HTMLElement>(`[data-testid="note-list-item"][data-note-id="${id}"]`)!
  expect(row).not.toBeNull()
  row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 50 }))
}

function menu(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-testid="context-menu"]')
}

function menuItem(id: string): HTMLElement {
  const node = document.querySelector<HTMLElement>(`[data-testid="context-menu-item-${id}"]`)
  expect(node).not.toBeNull()
  return node!
}

function menuItemIds(): string[] {
  return [...document.querySelectorAll<HTMLElement>('[data-testid^="context-menu-item-"]')].map((node) =>
    node.dataset.testid!.replace('context-menu-item-', ''),
  )
}

function clickMenuItem(id: string) {
  menuItem(id).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  root = undefined
  host = undefined
  document.body.replaceChildren()
  localStorage.clear()
  window.history.replaceState(null, '', '/')
  vi.unstubAllGlobals()
  delete (window.navigator as { clipboard?: unknown }).clipboard
  try {
    resolve(VaultService).cancelPending()
  } catch {
    // not registered in this test
  }
})

describe('note list context menu', () => {
  it('right-click on an unselected row selects it and shows the single-note menu', async () => {
    const { vault, list } = await mountNoteList()
    const a = await addNote(vault, 'Alpha')
    const b = await addNote(vault, 'Beta')
    expect(list.selectedIds).toEqual([])

    await act(async () => rightClickRow(a))
    expect(list.selectedIds).toEqual([a])
    expect(menu()).not.toBeNull()
    expect(menuItemIds()).toEqual(['open', 'rename', 'copy-wikilink', 'archive', 'delete'])
    // The untouched row stays unselected; no batch bar appears.
    expect(list.selectedIds).not.toContain(b)
    expect(host!.querySelector('[data-testid="note-list-batch"]')).toBeNull()
  })

  it('archives the right-clicked note', async () => {
    const { vault } = await mountNoteList()
    const a = await addNote(vault, 'Alpha')
    await act(async () => rightClickRow(a))
    await act(async () => clickMenuItem('archive'))
    expect(menu()).toBeNull()
    expect(vault.notes.find((note) => note.id === a)?.properties.archived).toBe(true)
  })

  it('deletes through the shared confirm modal', async () => {
    const { vault, list } = await mountNoteList()
    const a = await addNote(vault, 'Alpha')
    await act(async () => rightClickRow(a))
    await act(async () => clickMenuItem('delete'))
    expect(list.confirmingDelete).toBe(true)
    await act(async () => {
      document.querySelector<HTMLElement>('[data-testid="confirm-delete"]')!.click()
    })
    expect(vault.notes.some((note) => note.id === a)).toBe(false)
  })

  it('copies a wikilink for the note', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(window.navigator, 'clipboard', { value: { writeText }, configurable: true })
    const { vault } = await mountNoteList()
    const a = await addNote(vault, 'Alpha')
    await act(async () => rightClickRow(a))
    await act(async () => clickMenuItem('copy-wikilink'))
    expect(writeText).toHaveBeenCalledWith('[[Alpha]]')
  })

  it('shows the batch menu for a multi-selection and runs it through CommandService', async () => {
    const { vault, list } = await mountNoteList()
    const a = await addNote(vault, 'Alpha')
    const b = await addNote(vault, 'Beta')
    await act(async () => {
      list.selectedIds = [a, b]
      list.anchorId = a
    })
    await act(async () => rightClickRow(b))
    // Selection untouched: the right-clicked row was already selected.
    expect(list.selectedIds).toEqual([a, b])
    expect(menuItemIds()).toEqual(['archive-selected', 'retype-selected', 'delete-selected'])
    // Manifest titles are the labels (single source of truth).
    expect(menuItem('archive-selected').textContent).toContain('Archive Selected Notes')
    await act(async () => clickMenuItem('archive-selected'))
    expect(vault.notes.find((note) => note.id === a)?.properties.archived).toBe(true)
    expect(vault.notes.find((note) => note.id === b)?.properties.archived).toBe(true)
    expect(list.selectedIds).toEqual([])
  })

  it('right-clicking another row closes the open menu and opens a new one', async () => {
    const { vault, list } = await mountNoteList()
    const a = await addNote(vault, 'Alpha')
    const b = await addNote(vault, 'Beta')
    await act(async () => rightClickRow(a))
    expect(menu()).not.toBeNull()
    await act(async () => rightClickRow(b))
    expect(list.selectedIds).toEqual([b])
    expect(menu()).not.toBeNull()
    expect(menuItemIds()).toEqual(['open', 'rename', 'copy-wikilink', 'archive', 'delete'])
  })
})
