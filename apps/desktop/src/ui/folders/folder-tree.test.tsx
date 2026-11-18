import { has, register, resolve } from '@rabjs/react'
import { createNote, serializeNote } from '@stride/core/note'
import { notePath } from '@stride/core'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Rail } from '../../app'
import { FOLDER_NOTE_RENDER_CAP } from './folder-tree'
import { FolderService } from '../../services/vault/folder.service'
import { ListFilterService } from '../../services/search/list-filter.service'
import { LayoutService } from '../../services/layout/layout.service'
import { TabsService } from '../../services/notes/tabs.service'
import { VaultService } from '../../services/vault/vault.service'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

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
  register(LayoutService)
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
      const vault = resolve(VaultService)
      vault.unwatchDisk()
      vault.cancelPending()
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

  it('keeps the tree stable while list and search filters change', async () => {
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

    const listFilter = resolve(ListFilterService)
    for (const query of ['纪要', '进行', '12', '待办', 'FALSE', 'secret']) {
      await act(async () => listFilter.setQuery(query))
      expect(noteTitles(host)).toEqual(['会议纪要', 'Shopping'])
    }
    await act(async () => {
      vault.listFilter = 'Missing type'
      vault.searchQuery = '会议'
      vault.searchHits = [{ id: 'meeting' }] as typeof vault.searchHits
    })
    expect(noteTitles(host)).toEqual(['会议纪要', 'Shopping'])
  })

  it('selects and expands a folder idempotently', async () => {
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

    // A note created under the scope appears; repeated selection keeps the scope.
    await act(async () => {
      await resolve(FolderService).createNoteInFolder('box')
    })
    expect(vault.listFilter).toBe('folder:box')
    expect(vault.visibleNotes.map((note) => note.id)).toEqual([vault.activeId])
    expect(host.querySelector(`[data-testid="note-link"][data-note-id="${rootId}"]`)).not.toBeNull()
    expect(host.querySelector(`[data-testid="note-link"][data-note-id="${vault.activeId}"]`)).not.toBeNull()

    await act(async () => label!.click())
    expect(vault.listFilter).toBe('folder:box')
    expect(vault.visibleNotes.length).toBe(1)
  })

  it('scopes the note list to the parent of a clicked note', async () => {
    const { host, vault } = await mountRail()
    const folders = resolve(FolderService)
    await act(async () => {
      await vault.openFromDraft()
      await folders.createFolder('docs')
      await folders.createFolder('docs/guide')
      await folders.createFolder('other')
      await folders.createNoteInFolder('docs')
    })
    const docsId = vault.activeId
    await act(async () => {
      await folders.createNoteInFolder('docs/guide')
    })
    const guideId = vault.activeId
    await act(async () => {
      await folders.createNoteInFolder('other')
      vault.setFilter('folder:docs')
    })
    const otherId = vault.activeId

    const clickNote = (id: string) => {
      host.querySelector<HTMLButtonElement>(`[data-testid="note-link"][data-note-id="${id}"]`)!.click()
    }
    await act(async () => clickNote(guideId))
    expect(vault.activeId).toBe(guideId)
    expect(vault.listFilter).toBe('folder:docs/guide')
    expect(vault.visibleNotes.map((note) => note.id)).toEqual([guideId])
    expect(host.querySelector('[data-testid="folder-row"][data-path="docs/guide"] [data-testid="folder-label"]')?.getAttribute('aria-current')).toBe('page')

    await act(async () => clickNote(otherId))
    expect(vault.listFilter).toBe('folder:other')
    expect(vault.visibleNotes.map((note) => note.id)).toEqual([otherId])
    expect(vault.visibleNotes.map((note) => note.id)).not.toContain(docsId)

    await act(async () => clickNote(docsId))
    expect(vault.listFilter).toBe('folder:docs')
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
      folderLabel()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true, cancelable: true }))
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
      folderLabel()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true, cancelable: true }))
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

  it('refreshes a folder and note created on disk', async () => {
    const { host, vault } = await mountRail()
    await act(async () => {
      await vault.openFromDraft()
    })
    const button = host.querySelector<HTMLButtonElement>('[data-testid="refresh-folders"]')
    expect(button).not.toBeNull()
    expect(button!.disabled).toBe(false)
    const fs = vault.fs
    expect(fs).not.toBeNull()
    await fs!.mkdir('inbox-box')
    await fs!.writeText(
      notePath('inbox-box/fresh'),
      serializeNote(createNote('inbox-box/fresh', 'Fresh from disk')),
    )
    expect(host.querySelector('[data-testid="folder-row"][data-path="inbox-box"]')).toBeNull()

    await act(async () => {
      button!.click()
    })
    await vi.waitFor(() => {
      expect(host.querySelector('[data-testid="folder-row"][data-path="inbox-box"]')).not.toBeNull()
      expect(host.querySelector('[data-testid="folder-row"][data-path="inbox-box"]')?.getAttribute('aria-expanded')).toBe('false')
    })
  })

  it('starts folded and preserves descendants when a parent closes', async () => {
    const { host, vault } = await mountRail()
    await act(async () => {
      await vault.openFromDraft()
      await vault.fs!.mkdir('docs/guide')
      await resolve(FolderService).loadFolders()
    })
    const layout = resolve(LayoutService)
    const toggle = (path: string) => host.querySelector<HTMLButtonElement>(`[data-testid="folder-toggle"][data-path="${path}"]`)!
    expect(toggle('docs').getAttribute('aria-expanded')).toBe('false')
    expect(toggle('docs/guide')).toBeNull()
    await act(async () => toggle('docs').click())
    expect(toggle('docs/guide').getAttribute('aria-expanded')).toBe('false')
    await act(async () => toggle('docs/guide').click())
    await act(async () => toggle('docs').click())
    await act(async () => toggle('docs').click())
    expect(toggle('docs/guide').getAttribute('aria-expanded')).toBe('true')
    expect(vault.listFilter).toBe('all')
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="collapse-all-folders"]')!.click())
    expect(layout.isFolderCollapsed('docs/guide')).toBe(true)
    expect(vault.listFilter).toBe('all')
  })

  it('uses arrows to navigate without selecting and F2 only inside the tree', async () => {
    const { host, vault } = await mountRail()
    await act(async () => {
      await vault.openFromDraft()
      await vault.fs!.mkdir('docs/guide')
      await resolve(FolderService).loadFolders()
    })
    const row = (path: string) => host.querySelector<HTMLElement>(`[data-testid="folder-row"][data-path="${path}"]`)!
    const key = async (value: string) => act(async () => {
      document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }))
    })
    row('docs').focus()
    await key('ArrowRight')
    expect(row('docs').getAttribute('aria-expanded')).toBe('true')
    expect(document.activeElement).toBe(row('docs'))
    await key('ArrowRight')
    expect(document.activeElement).toBe(row('docs/guide'))
    expect(vault.listFilter).toBe('all')
    await key('ArrowLeft')
    expect(document.activeElement).toBe(row('docs'))
    await key('Enter')
    expect(vault.listFilter).toBe('folder:docs')
    await act(async () => row('docs').querySelector('[data-testid="folder-label"]')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })))
    expect(host.querySelector('.folder-rename-input')).toBeNull()
    expect(host.querySelectorAll('[role="treeitem"][tabindex="0"]').length).toBe(1)
  })

  it('does not reopen manually collapsed folders on tab activation or refresh', async () => {
    const { host, vault } = await mountRail()
    await act(async () => {
      await vault.openFromDraft()
      await resolve(FolderService).createFolder('docs')
      await resolve(FolderService).createNoteInFolder('docs')
    })
    const nested = vault.activeId
    const tabs = resolve(TabsService)
    await act(async () => {
      tabs.openNote(nested)
      await vault.createNote()
    })
    const other = vault.activeId
    await act(async () => {
      tabs.openNote(other)
      resolve(LayoutService).collapseAllFolders()
      tabs.activateTab(tabs.tabs.find(tab => tab.noteId === nested)!.id)
      await vault.refreshFromDisk()
    })
    expect(vault.activeId).toBe(nested)
    expect(host.querySelector(`[data-note-id="${nested}"]`)).toBeNull()
    expect(resolve(LayoutService).isFolderCollapsed('docs')).toBe(true)
  })


  it('opens a drag-hover target after a delay and cancels when leaving', async () => {
    const { host, vault } = await mountRail()
    await act(async () => {
      await vault.openFromDraft()
      await vault.fs!.mkdir('docs/guide')
      await resolve(FolderService).loadFolders()
    })
    const row = host.querySelector<HTMLElement>('[data-testid="folder-row"][data-path="docs"]')!
    const dataTransfer = new DataTransfer()
    dataTransfer.setData('text/plain', 'note')
    vi.useFakeTimers()
    try {
      await act(async () => row.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer })))
      await act(async () => vi.advanceTimersByTime(599))
      expect(row.getAttribute('aria-expanded')).toBe('false')
      await act(async () => row.dispatchEvent(new DragEvent('dragleave', { bubbles: true })))
      await act(async () => vi.advanceTimersByTime(1000))
      expect(row.getAttribute('aria-expanded')).toBe('false')
      await act(async () => row.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer })))
      await act(async () => vi.advanceTimersByTime(600))
      expect(row.getAttribute('aria-expanded')).toBe('true')
      expect(vault.listFilter).toBe('all')
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps expansion on a real folder rename and isolates real vault switches', async () => {
    const { host, vault } = await mountRail()
    const folders = resolve(FolderService)
    const layout = resolve(LayoutService)
    await act(async () => {
      await vault.openFromDraft()
      await folders.createFolder('docs/guide')
      layout.setFolderCollapsed('docs', true)
      await folders.renameFolder('docs', 'work')
    })
    const first = vault.activeVaultId
    expect(layout.isFolderCollapsed('work')).toBe(true)
    expect(layout.isFolderCollapsed('work/guide')).toBe(false)
    await act(async () => {
      await vault.createNewVault()
      await vault.fs!.mkdir('work/guide')
      await folders.loadFolders()
    })
    const second = vault.activeVaultId
    expect(second).not.toBe(first)
    expect(layout.isFolderCollapsed('work/guide')).toBe(true)
    await act(async () => vault.switchVault(first))
    expect(layout.isFolderCollapsed('work')).toBe(true)
    expect(layout.isFolderCollapsed('work/guide')).toBe(false)
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="folder-toggle"][data-path="work"]')!.click())
    expect(host.querySelector('[data-path="work/guide"]')?.getAttribute('aria-expanded')).toBe('true')
  })

})
