import { has, register, resolve } from '@rabjs/react'
import { createNote } from '@stride/core/note'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Rail } from '../app'
import { FolderService } from '../services/folder.service'
import { ListFilterService } from '../services/list-filter.service'
import { VaultService } from '../services/vault.service'

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
    expect(host.querySelector('[data-testid="create-folder"]')).not.toBeNull()
    await act(async () => {
      setInputValue(input!, 'box')
    })
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="create-folder"]')?.click()
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 0))
    })
    const row = host.querySelector<HTMLElement>('[data-testid="folder-row"][data-path="box"]')
    expect(row).not.toBeNull()
    expect(host.querySelector('[data-testid="rename-folder"]')).not.toBeNull()
    expect(host.querySelector('[data-testid="delete-folder"]')).not.toBeNull()

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

    const input = host.querySelector<HTMLInputElement>('[data-testid="list-filter"]')
    expect(input).not.toBeNull()
    expect(input?.placeholder).toBe('过滤标题或属性')
    expect(noteTitles(host)).toEqual(['会议纪要', 'Shopping'])
    expect(host.querySelector('[data-testid="list-filter-clear"]')).toBeNull()

    await act(async () => {
      setInputValue(input!, '纪要')
    })
    expect(noteTitles(host)).toEqual(['会议纪要'])
    expect(host.querySelector('[data-testid="list-filter-clear"]')).not.toBeNull()

    await act(async () => {
      setInputValue(input!, '进行')
    })
    expect(noteTitles(host)).toEqual(['会议纪要'])

    await act(async () => {
      setInputValue(input!, '12')
    })
    expect(noteTitles(host)).toEqual(['会议纪要'])

    await act(async () => {
      setInputValue(input!, '待办')
    })
    expect(noteTitles(host)).toEqual(['会议纪要'])

    await act(async () => {
      setInputValue(input!, 'FALSE')
    })
    expect(noteTitles(host)).toEqual(['Shopping'])

    await act(async () => {
      setInputValue(input!, 'secret')
    })
    expect(noteTitles(host)).toEqual([])

    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="list-filter-clear"]')?.click()
    })
    expect(input?.value).toBe('')
    expect(noteTitles(host)).toEqual(['会议纪要', 'Shopping'])
    expect(host.querySelector('[data-testid="list-filter-clear"]')).toBeNull()
  })
})
