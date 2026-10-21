import { has, register, resolve } from '@rabjs/react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Rail } from '../../app'
import { FolderService } from '../../services/vault/folder.service'
import { ListFilterService } from '../../services/search/list-filter.service'
import { NoteListService } from '../../services/notes/note-list.service'
import { VaultService } from '../../services/vault/vault.service'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined

function useMemoryFixture() {
  window.history.replaceState(null, '', '/?fixture=memory')
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

async function mountRail(): Promise<{ host: HTMLElement; vault: VaultService; folders: FolderService }> {
  useMemoryFixture()
  vi.stubGlobal('showDirectoryPicker', vi.fn())
  register(VaultService)
  register(FolderService)
  if (!has(ListFilterService)) register(ListFilterService)
  resolve(ListFilterService).clear()
  const noteList = resolve(NoteListService)
  noteList.clearSelection()
  noteList.confirmingDelete = false
  const vault = resolve(VaultService)
  vault.cancelPending()
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root?.render(<Rail />)
  })
  await act(async () => {
    await vault.openFromDraft()
  })
  return { host, vault, folders: resolve(FolderService) }
}

function rightClick(node: HTMLElement | null) {
  expect(node).not.toBeNull()
  node!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 15, clientY: 15 }))
}

function menuItemIds(): string[] {
  return [...document.querySelectorAll<HTMLElement>('[data-testid^="context-menu-item-"]')].map((node) =>
    node.dataset.testid!.replace('context-menu-item-', ''),
  )
}

function clickMenuItem(id: string) {
  const node = document.querySelector<HTMLElement>(`[data-testid="context-menu-item-${id}"]`)
  expect(node).not.toBeNull()
  node!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  root = undefined
  document.body.replaceChildren()
  localStorage.clear()
  window.history.replaceState(null, '', '/')
  vi.unstubAllGlobals()
  try {
    resolve(VaultService).cancelPending()
  } catch {
    // not registered in this test
  }
})

describe('folder tree context menu', () => {
  it('right-click on a folder row shows folder actions; rename starts inline rename', async () => {
    const { host, folders } = await mountRail()
    await act(async () => {
      await folders.createFolder('box')
    })
    await act(async () => rightClick(host.querySelector('[data-testid="folder-row"][data-path="box"]')))
    expect(menuItemIds()).toEqual(['new-note-here', 'new-folder-inside', 'rename-folder', 'delete-folder'])
    await act(async () => clickMenuItem('rename-folder'))
    expect(host.querySelector('input.folder-rename-input')).not.toBeNull()
  })

  it('deletes a folder through the confirm modal', async () => {
    const { host, folders } = await mountRail()
    await act(async () => {
      await folders.createFolder('box')
    })
    await act(async () => rightClick(host.querySelector('[data-testid="folder-row"][data-path="box"]')))
    await act(async () => clickMenuItem('delete-folder'))
    const confirm = document.querySelector<HTMLElement>('[data-testid="confirm-delete-folder"]')
    expect(confirm).not.toBeNull()
    await act(async () => {
      confirm!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 0))
    })
    expect(folders.folders).not.toContain('box')
  })

  it('creates a nested folder from "New Folder Inside"', async () => {
    const { host, folders } = await mountRail()
    await act(async () => {
      await folders.createFolder('box')
    })
    await act(async () => rightClick(host.querySelector('[data-testid="folder-row"][data-path="box"]')))
    await act(async () => clickMenuItem('new-folder-inside'))
    const input = host.querySelector<HTMLInputElement>('[data-testid="folder-child-name"]')
    expect(input).not.toBeNull()
    await act(async () => setInputValue(input!, 'inner'))
    await act(async () => {
      host.querySelector<HTMLElement>('[data-testid="create-folder-child"]')!.click()
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 0))
    })
    expect(folders.folders).toContain('box/inner')
  })

  it('creates a note inside the folder from "New Note Here"', async () => {
    const { host, vault, folders } = await mountRail()
    await act(async () => {
      await folders.createFolder('box')
    })
    await act(async () => rightClick(host.querySelector('[data-testid="folder-row"][data-path="box"]')))
    await act(async () => {
      clickMenuItem('new-note-here')
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 0))
    })
    expect(vault.activeId.startsWith('box/')).toBe(true)
    expect(vault.notes.some((note) => note.id === vault.activeId)).toBe(true)
  })

  it('right-click on a note link shows note actions; delete drives the shared confirm state', async () => {
    const { host, vault } = await mountRail()
    await act(async () => {
      await vault.createNote()
    })
    const id = vault.activeId
    const link = host.querySelector<HTMLElement>(`[data-testid="note-link"][data-note-id="${id}"]`)
    expect(link).not.toBeNull()
    await act(async () => rightClick(link))
    expect(menuItemIds()).toEqual(['open', 'copy-wikilink', 'archive', 'delete'])
    await act(async () => clickMenuItem('delete'))
    const noteList = resolve(NoteListService)
    expect(noteList.selectedIds).toEqual([id])
    expect(noteList.confirmingDelete).toBe(true)
  })

  it('right-click on empty tree space offers New Folder at the root', async () => {
    const { host } = await mountRail()
    await act(async () => rightClick(host.querySelector('[data-testid="folder-root"]')))
    expect(menuItemIds()).toEqual(['new-folder'])
    await act(async () => clickMenuItem('new-folder'))
    expect(host.querySelector('[data-testid="folder-name"]')).not.toBeNull()
  })
})
