import { register, resolve } from '@rabjs/react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Rail } from '../../app'
import { FolderService } from '../vault/folder.service'
import { VaultService } from '../vault/vault.service'
import { ViewsService, type ViewDraft } from './views.service'
import { NoteList } from '../../ui/note-list/note-list'

let root: Root | undefined

function useMemoryFixture() {
  window.history.replaceState(null, '', '/?fixture=memory')
}

function draft(partial: Partial<ViewDraft>): ViewDraft {
  return {
    file: '',
    name: '',
    icon: '',
    type: '',
    sortKey: '',
    sortDir: 'desc',
    archived: false,
    filters: [],
    ...partial,
  }
}

function viewLinks(host: HTMLElement): HTMLElement[] {
  return [...host.querySelectorAll<HTMLElement>('[data-testid="view-link"]')]
}

function viewNames(host: HTMLElement): string[] {
  return viewLinks(host).map((node) => node.textContent?.trim() ?? '')
}

async function click(host: HTMLElement | Document, selector: string) {
  const button = host.querySelector<HTMLButtonElement>(selector)
  if (!button) throw new Error(`missing ${selector}`)
  await act(async () => {
    button.click()
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 0))
  })
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

/** Minimal DataTransfer stand-in; jsdom has no DragEvent/dataTransfer. */
function fakeDataTransfer() {
  const data = new Map<string, string>()
  return {
    setData: (type: string, value: string) => void data.set(type, value),
    getData: (type: string) => data.get(type) ?? '',
    types: [...data.keys()],
    effectAllowed: '',
    dropEffect: '',
  }
}

function fireDragEvent(node: Element, type: string, dataTransfer: ReturnType<typeof fakeDataTransfer>) {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: dataTransfer })
  node.dispatchEvent(event)
}

async function mountRail(): Promise<{ host: HTMLElement; vault: VaultService; views: ViewsService }> {
  useMemoryFixture()
  vi.stubGlobal('showDirectoryPicker', vi.fn())
  register(VaultService)
  register(FolderService)
  const vault = resolve(VaultService)
  const views = resolve(ViewsService)
  vault.collapsedTypes = []
  vault.cancelPending()
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root?.render(<Rail />)
  })
  await act(async () => {
    await vault.createNewVault()
  })
  return { host, vault, views }
}

async function saveView(views: ViewsService, partial: Partial<ViewDraft>) {
  await act(async () => {
    views.draft = draft(partial)
    await views.saveDraft()
  })
}

describe('saved views rail', () => {
  afterEach(() => {
    root?.unmount()
    root = undefined
    document.body.replaceChildren()
    localStorage.clear()
    window.history.replaceState(null, '', '/')
    vi.unstubAllGlobals()
    try {
      const vault = resolve(VaultService)
      vault.cancelPending()
      vault.setFilter('all')
      resolve(ViewsService).draft = null
    } catch {
      // Services are registered by the cases that mount the rail.
    }
  })

  it('lists saved views, activates on click, and reopens the editor prefilled', async () => {
    const { host, vault, views } = await mountRail()
    expect(viewNames(host)).toEqual([])

    await saveView(views, { name: 'Reading', icon: '📚', type: 'Article' })
    await saveView(views, { name: 'Errands' })
    expect(viewNames(host)).toEqual(['📚Reading', 'Errands'])

    await click(host, '[data-testid="view-link"][data-view="reading"]')
    expect(vault.listFilter).toBe('view:reading')
    expect(host.querySelector('[data-testid="view-link"][data-view="reading"]')?.className).toContain('active')
    expect(host.querySelector('[data-testid="view-link"][data-view="errands"]')?.className ?? '').not.toContain('active')

    await click(host, '[data-testid="view-edit"][data-view="reading"]')
    const nameInput = document.querySelector<HTMLInputElement>('[data-testid="view-name"]')
    expect(nameInput?.value).toBe('Reading')
    await click(document, '[data-testid="view-cancel"]')
    expect(views.draft).toBeNull()
  })

  it('creates a view through the New view editor flow', async () => {
    const { host, vault, views } = await mountRail()
    await click(host, '[data-testid="new-view"]')
    expect(views.draft).not.toBeNull()
    const nameInput = document.querySelector<HTMLInputElement>('[data-testid="view-name"]')!
    await act(async () => {
      setInputValue(nameInput, 'Focus')
    })
    // Blank-key / empty-value filter rows are dropped on save.
    await click(document, '[data-testid="view-filter-add"]')
    await click(document, '[data-testid="view-save"]')
    expect(views.draft).toBeNull()
    expect(viewNames(host)).toEqual(['Focus'])
    const onDisk = JSON.parse(await vault.fs!.readText('views/focus.json')) as { name: string }
    expect(onDisk.name).toBe('Focus')
    expect(JSON.stringify(onDisk)).not.toContain('propertyFilters')
  })

  it('deletes a view from the editor', async () => {
    const { host, vault, views } = await mountRail()
    await saveView(views, { name: 'Reading' })
    views.activate('reading')
    await click(host, '[data-testid="view-edit"][data-view="reading"]')
    await click(document, '[data-testid="view-delete"]')
    expect(viewNames(host)).toEqual([])
    expect(vault.listFilter).toBe('all')
    expect(await vault.fs!.stat('views/reading.json')).toBeNull()
  })

  it('drag-reorders rows and persists the new order', async () => {
    const { host, views } = await mountRail()
    await saveView(views, { name: 'Alpha' })
    await saveView(views, { name: 'Beta' })
    await saveView(views, { name: 'Gamma' })
    expect(viewNames(host)).toEqual(['Alpha', 'Beta', 'Gamma'])

    const gamma = host.querySelector('[data-testid="view-row"][data-view="gamma"]')!
    const alpha = host.querySelector('[data-testid="view-row"][data-view="alpha"]')!
    const dt = fakeDataTransfer()
    await act(async () => {
      fireDragEvent(gamma, 'dragstart', dt)
      fireDragEvent(alpha, 'dragover', dt)
      fireDragEvent(alpha, 'drop', dt)
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 0))
    })
    expect(viewNames(host)).toEqual(['Gamma', 'Alpha', 'Beta'])
    expect(views.views.map((item) => item.file)).toEqual(['gamma', 'alpha', 'beta'])
  })
})

describe('note list under a saved view', () => {
  afterEach(() => {
    root?.unmount()
    root = undefined
    document.body.replaceChildren()
    localStorage.clear()
    window.history.replaceState(null, '', '/')
    vi.unstubAllGlobals()
    try {
      const vault = resolve(VaultService)
      vault.cancelPending()
      vault.setFilter('all')
      resolve(ViewsService).draft = null
    } catch {
      // Services are registered by the cases that mount the list.
    }
  })

  function itemTitles(host: HTMLElement): string[] {
    return [...host.querySelectorAll('[data-testid="note-list-item"] .note-list-item-title')]
      .map((node) => node.textContent ?? '')
  }

  it('shows the view name and applies the view sort over the manual sort', async () => {
    useMemoryFixture()
    vi.stubGlobal('showDirectoryPicker', vi.fn())
    register(VaultService)
    const vault = resolve(VaultService)
    const views = resolve(ViewsService)
    vault.cancelPending()
    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => {
      root?.render(<NoteList />)
      await vault.createNewVault()
    })

    // Alpha created first, Zulu second: the default manual sort (mtime desc)
    // shows Zulu first, the view's title-asc sort must show Alpha first.
    await act(async () => {
      await vault.createNote()
      vault.updateTitle('Alpha')
      await vault.flush()
      await vault.createNote()
      vault.updateTitle('Zulu')
      await vault.flush()
    })

    await act(async () => {
      views.draft = draft({ name: 'By title', sortKey: 'title', sortDir: 'asc' })
      await views.saveDraft()
    })
    await act(async () => {
      views.activate('by-title')
    })

    expect(host.querySelector('[data-testid="note-list-title"]')?.textContent).toBe('By title')
    expect(itemTitles(host)).toEqual(['Alpha', 'Zulu'])

    // Back on All, the manual mtime-desc sort applies again.
    await act(async () => {
      vault.setFilter('all')
    })
    expect(host.querySelector('[data-testid="note-list-title"]')?.textContent).toBe('All notes')
    expect(itemTitles(host)).toEqual(['Zulu', 'Alpha'])
  })
})
