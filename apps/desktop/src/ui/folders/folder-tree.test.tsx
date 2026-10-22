import { has, register, resolve } from '@rabjs/react'
import { createNote } from '@stride/core/note'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Rail } from '../../app'
import { FOLDER_NOTE_RENDER_CAP } from './folder-tree'
import { FolderService } from '../../services/vault/folder.service'
import { ListFilterService } from '../../services/search/list-filter.service'
import { VaultService } from '../../services/vault/vault.service'

let root: Root | undefined

if (typeof DataTransfer === 'undefined') {
  class MemoryDataTransfer {
    dropEffect = 'none'
    effectAllowed = 'all'
    readonly files = { length: 0, item: () => null }
    readonly items = { length: 0, add: () => null, remove: () => undefined, clear: () => undefined }
    types: string[] = []
    private readonly values = new Map<string, string>()
    setData(format: string, data: string) {
      this.values.set(format, data)
      if (!this.types.includes(format)) this.types.push(format)
    }
    getData(format: string) {
      return this.values.get(format) ?? ''
    }
    clearData(format?: string) {
      if (format) {
        this.values.delete(format)
        this.types = this.types.filter((item) => item !== format)
        return
      }
      this.values.clear()
      this.types = []
    }
    setDragImage() {}
  }
  Object.defineProperty(globalThis, 'DataTransfer', { value: MemoryDataTransfer })
}

if (typeof DragEvent === 'undefined') {
  class MemoryDragEvent extends MouseEvent {
    dataTransfer: DataTransfer | null
    constructor(type: string, init: DragEventInit = {}) {
      super(type, init)
      this.dataTransfer = init.dataTransfer ?? null
    }
  }
  Object.defineProperty(globalThis, 'DragEvent', { value: MemoryDragEvent })
}

function useMemoryFixture() {
  window.history.replaceState(null, '', '/?fixture=memory')
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

function resetListFilter() {
  if (!has(ListFilterService)) register(ListFilterService)
  resolve(ListFilterService).clear()
}

function noteTitles(host: HTMLElement): string[] {
  return [...host.querySelectorAll('[data-testid="note-link"]')].map((node) => node.textContent ?? '')
}

async function mountRail(): Promise<{ host: HTMLElement; vault: VaultService }> {
  useMemoryFixture()
  vi.stubGlobal('showDirectoryPicker', vi.fn())
  register(VaultService)
  register(FolderService)
  resetListFilter()
  const vault = resolve(VaultService)
  vault.cancelPending()
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root?.render(<Rail />)
  })
  return { host, vault }
}

describe('folder tree', () => {
  afterEach(() => {
    root?.unmount()
    root = undefined
    document.body.replaceChildren()
    resetListFilter()
    localStorage.clear()
    window.history.replaceState(null, '', '/')
    vi.unstubAllGlobals()
    try {
      resolve(VaultService).cancelPending()
    } catch {
      // The service is registered by the cases that render the rail.
    }
  })

  it('keeps note links, lists a created folder, and moves a note onto it', async () => {
    const { host, vault } = await mountRail()
    await act(async () => {
      await vault.openFromDraft()
      await vault.createNote()
    })
    const title = vault.active?.title ?? ''
    const beforeId = vault.activeId
    expect(title).not.toBe('')
    expect(host.querySelector('[data-testid="note-link"]')?.textContent).toBe(title)
    expect(host.querySelector<HTMLElement>('[data-testid="note-link"]')?.dataset.noteId).toBe(beforeId)

    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="new-folder"]')?.click()
    })
    const input = host.querySelector<HTMLInputElement>('[data-testid="folder-name"]')
    expect(input).not.toBeNull()
    await act(async () => {
      setInputValue(input!, 'box')
      input!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 0))
    })
    const row = host.querySelector<HTMLElement>('[data-testid="folder-row"][data-path="box"]')
    expect(row).not.toBeNull()
    // Hover keeps a single "new note here" affordance; rename/delete live in
    // the right-click menu (covered by folder-tree-context-menu.test.tsx).
    expect(host.querySelector('[data-testid="folder-new-note"]')).not.toBeNull()
    expect(host.querySelector('[data-testid="rename-folder"]')).toBeNull()
    expect(host.querySelector('[data-testid="delete-folder"]')).toBeNull()

    const note = host.querySelector<HTMLElement>('[data-testid="note-link"]')
    expect(note).not.toBeNull()
    const dataTransfer = new DataTransfer()
    await act(async () => {
      note?.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer }))
      row?.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer }))
      row?.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }))
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 0))
    })

    const basename = beforeId.split('/').pop() ?? beforeId
    expect(vault.activeId).toBe(`box/${basename}`)
    expect(vault.active?.title).toBe(title)
    expect(vault.active?.id).toBe(`box/${basename}`)
    expect(host.querySelector('[data-testid="note-link"]')?.textContent).toBe(title)
    expect(host.querySelector<HTMLElement>('[data-testid="note-link"]')?.dataset.noteId).toBe(`box/${basename}`)
  })

  it('filters visible notes by title or property as the query is typed', async () => {
    const { host, vault } = await mountRail()
    await act(async () => {
      await vault.openFromDraft()
    })
    const meeting = createNote('meeting', '会议纪要')
    meeting.properties = { status: '进行中', count: 12, tags: ['待办'], _icon: 'secret-icon' }
    const other = createNote('other', 'Shopping')
    other.properties = { ready: false }
    await act(async () => {
      vault.listFilter = 'all'
      vault.searchQuery = ''
      vault.searchHits = []
      vault.notes = [meeting, other]
    })

    // The filter input lives in the note list header (T6.1); the tree keeps
    // applying the shared ListFilterService query.
    const listFilter = resolve(ListFilterService)
    expect(noteTitles(host)).toEqual(['会议纪要', 'Shopping'])

    await act(async () => {
      listFilter.setQuery('纪要')
    })
    expect(noteTitles(host)).toEqual(['会议纪要'])

    await act(async () => {
      listFilter.setQuery('进行')
    })
    expect(noteTitles(host)).toEqual(['会议纪要'])

    await act(async () => {
      listFilter.setQuery('12')
    })
    expect(noteTitles(host)).toEqual(['会议纪要'])

    await act(async () => {
      listFilter.setQuery('待办')
    })
    expect(noteTitles(host)).toEqual(['会议纪要'])

    await act(async () => {
      listFilter.setQuery('FALSE')
    })
    expect(noteTitles(host)).toEqual(['Shopping'])

    await act(async () => {
      listFilter.setQuery('secret')
    })
    expect(noteTitles(host)).toEqual([])

    await act(async () => {
      listFilter.clear()
    })
    expect(noteTitles(host)).toEqual(['会议纪要', 'Shopping'])
  })

  it('scopes the note list to the clicked folder and toggles back to all', async () => {
    const { host, vault } = await mountRail()
    await act(async () => {
      await vault.openFromDraft()
      await vault.createNote()
    })
    const rootId = vault.activeId
    await act(async () => {
      await resolve(FolderService).createFolder('box')
    })
    const label = host.querySelector<HTMLElement>(
      '[data-testid="folder-row"][data-path="box"] [data-testid="folder-label"]',
    )
    expect(label).not.toBeNull()

    await act(async () => label!.click())
    expect(vault.listFilter).toBe('folder:box')
    expect(vault.visibleNotes.map((note) => note.id)).not.toContain(rootId)
    expect(label!.getAttribute('aria-current')).toBe('page')
    // Scoping the list column never collapses the tree: the root note's link
    // stays rendered while the folder scope is active.
    expect(host.querySelector(`[data-testid="note-link"][data-note-id="${rootId}"]`)).not.toBeNull()

    // A note created under the scope appears; a second click releases it.
    await act(async () => {
      await resolve(FolderService).createNoteInFolder('box')
    })
    expect(vault.listFilter).toBe('folder:box')
    expect(vault.visibleNotes.map((note) => note.id)).toEqual([vault.activeId])
    expect(host.querySelector(`[data-testid="note-link"][data-note-id="${rootId}"]`)).not.toBeNull()
    expect(host.querySelector(`[data-testid="note-link"][data-note-id="${vault.activeId}"]`)).not.toBeNull()

    await act(async () => label!.click())
    expect(vault.listFilter).toBe('all')
    expect(vault.visibleNotes.length).toBe(2)
  })

  it('commits an inline rename on Enter and cancels on Escape', async () => {
    const { host, vault } = await mountRail()
    await act(async () => {
      await vault.openFromDraft()
      await resolve(FolderService).createFolder('box')
    })
    const folderLabel = () =>
      host.querySelector<HTMLElement>('[data-testid="folder-row"][data-path="box"] [data-testid="folder-label"]')
    await act(async () => {
      folderLabel()!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
    })
    const input = host.querySelector<HTMLInputElement>('input.folder-rename-input')
    expect(input).not.toBeNull()

    // Escape leaves the name untouched.
    await act(async () => {
      setInputValue(input!, 'renamed')
      input!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
    expect(host.querySelector('input.folder-rename-input')).toBeNull()
    expect(resolve(FolderService).folders).toContain('box')

    // Enter commits the rename.
    await act(async () => {
      folderLabel()!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
    })
    const again = host.querySelector<HTMLInputElement>('input.folder-rename-input')
    await act(async () => {
      setInputValue(again!, 'renamed')
      again!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 0))
    })
    expect(resolve(FolderService).folders).toContain('renamed')
    expect(resolve(FolderService).folders).not.toContain('box')
  })

  it('caps rendered note links per folder and summarizes the overflow', async () => {
    const { host, vault } = await mountRail()
    await act(async () => {
      vault.listFilter = 'all'
      vault.searchQuery = ''
      vault.searchHits = []
      vault.notes = Array.from({ length: FOLDER_NOTE_RENDER_CAP + 5 }, (_, index) =>
        createNote(`cap-${index}`, `Cap note ${index}`))
    })
    expect(host.querySelectorAll('[data-testid="note-link"]').length).toBe(FOLDER_NOTE_RENDER_CAP)
    expect(host.querySelector('[data-testid="folder-overflow"]')?.textContent).toContain('5 more')
  })
})
