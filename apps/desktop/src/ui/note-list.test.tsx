import { has, register, resolve } from '@rabjs/react'
import { createNote } from '@stride/core/note'
import { MemoryFileSystem } from '@stride/platform'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { initializeVault } from '../../../../packages/core/src/seed'
import { createVaultNote } from '../../../../packages/core/src/vault'
import { ListFilterService } from '../services/list-filter.service'
import { VaultService } from '../services/vault.service'
import { NoteList, noteListTitle, noteSnippet, relativeDay } from './note-list'

let root: Root | undefined
let host: HTMLElement | undefined

function useMemoryFixture() {
  window.history.replaceState(null, '', '/?fixture=memory')
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

function noteWithBody(id: string, title: string, body: string) {
  const note = createNote(id, title)
  note.doc = {
    type: 'doc',
    content: [
      { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: title }] },
      { type: 'paragraph', content: [{ type: 'text', text: body }] },
    ],
  }
  return note
}

async function mountNoteList(): Promise<{ vault: VaultService }> {
  useMemoryFixture()
  vi.stubGlobal('showDirectoryPicker', vi.fn())
  register(VaultService)
  if (!has(ListFilterService)) register(ListFilterService)
  resolve(ListFilterService).clear()
  const vault = resolve(VaultService)
  vault.cancelPending()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root?.render(<NoteList />)
  })
  return { vault }
}

function itemTitles(): string[] {
  return [...host!.querySelectorAll('[data-testid="note-list-item"] .note-list-item-title')]
    .map((node) => node.textContent ?? '')
}

describe('noteSnippet', () => {
  it('collapses whitespace, drops the leading title, and truncates', () => {
    const note = noteWithBody('a', 'My title', 'first  line\n\nsecond line')
    expect(noteSnippet(note)).toBe('first line second line')
    const long = noteWithBody('b', 'T', 'x'.repeat(200))
    const snippet = noteSnippet(long, 50)
    expect(snippet.length).toBeLessThanOrEqual(51)
    expect(snippet.endsWith('…')).toBe(true)
  })

  it('returns an empty string for empty notes', () => {
    expect(noteSnippet(createNote('c', 'Empty'))).toBe('')
  })
})

describe('relativeDay', () => {
  const now = new Date(2026, 9, 15, 15, 0).getTime()

  it('labels today, yesterday, recent days, and older dates', () => {
    expect(relativeDay(new Date(2026, 9, 15, 9, 0).getTime(), now)).toBe('Today')
    expect(relativeDay(new Date(2026, 9, 14, 23, 0).getTime(), now)).toBe('Yesterday')
    expect(relativeDay(new Date(2026, 9, 11, 12, 0).getTime(), now)).toBe('4 days ago')
    expect(relativeDay(new Date(2026, 2, 3).getTime(), now)).toBe('3 Mar')
    expect(relativeDay(new Date(2025, 11, 31).getTime(), now)).toBe('31 Dec 2025')
  })

  it('returns an empty label when no mtime is known', () => {
    expect(relativeDay(0, now)).toBe('')
  })
})

describe('noteMtimes (open-time harvest)', () => {
  afterEach(() => {
    window.history.replaceState(null, '', '/')
    vi.unstubAllGlobals()
    try {
      resolve(VaultService).cancelPending()
    } catch {
      // not registered in pure-helper-only runs
    }
  })

  it('fills noteMtimes from file stats when a vault opens', async () => {
    useMemoryFixture()
    vi.stubGlobal('showDirectoryPicker', vi.fn())
    register(VaultService)
    const vault = resolve(VaultService)
    await act(async () => {
      await vault.openFromDraft()
      await vault.createNote()
    })
    const id = vault.activeId
    await act(async () => {
      vault.noteMtimes = {}
      // Reopen the same memory vault: the open path stats every file.
      await vault.openFromDraft()
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 0))
    })
    expect(vault.noteMtimes[id] ?? 0).toBeGreaterThan(0)
  })

  it('fills noteMtimes when opening a raw backend, not just fixture-owned ones', async () => {
    // Regression: openBackendBody assigned `this.fs = backend`, then the
    // refreshMtimes guard compared the reactive proxy in `this.fs` against the
    // raw reference and always bailed, leaving noteMtimes empty in production.
    useMemoryFixture()
    register(VaultService)
    const vault = resolve(VaultService)
    const backend = new MemoryFileSystem('raw-vault')
    await initializeVault(backend, '/Users/stride')
    const note = await createVaultNote(backend, 'Dated note')
    await act(async () => {
      await vault.openClonedVault(backend)
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 0))
    })
    expect(vault.noteMtimes[note.id] ?? 0).toBeGreaterThan(0)
  })
})

describe('NoteList', () => {
  afterEach(() => {
    root?.unmount()
    root = undefined
    host?.remove()
    host = undefined
    resolve(ListFilterService).clear()
    window.history.replaceState(null, '', '/')
    vi.unstubAllGlobals()
    try {
      resolve(VaultService).cancelPending()
    } catch {
      // not registered in pure-helper-only runs
    }
  })

  it('lists visible notes with title, snippet, and relative date; click selects', async () => {
    const { vault } = await mountNoteList()
    const moss = noteWithBody('moss', 'Moss notes', 'The bricks stay damp until noon.')
    const walks = noteWithBody('walks', 'Index of walks', 'North wall, the path, the lane.')
    await act(async () => {
      vault.listFilter = 'all'
      vault.searchQuery = ''
      vault.searchHits = []
      vault.notes = [moss, walks]
      vault.noteMtimes = { moss: Date.now(), walks: Date.now() - 3 * 86_400_000 }
    })
    expect(itemTitles()).toEqual(['Moss notes', 'Index of walks'])
    expect(host!.querySelector('[data-testid="note-list-count"]')?.textContent).toBe('2')
    expect(host!.querySelector('[data-testid="note-list-title"]')?.textContent).toBe('All notes')
    const first = host!.querySelector('[data-note-id="moss"]')!
    expect(first.querySelector('.note-list-item-snippet')?.textContent).toBe('The bricks stay damp until noon.')
    expect(first.querySelector('.note-list-item-date')?.textContent).toBe('Today')
    expect(host!.querySelector('[data-note-id="walks"] .note-list-item-date')?.textContent).toBe('3 days ago')

    await act(async () => {
      host!.querySelector<HTMLButtonElement>('[data-note-id="walks"]')!.click()
    })
    expect(vault.activeId).toBe('walks')
    expect(host!.querySelector('[data-note-id="walks"]')?.getAttribute('aria-current')).toBe('true')
    expect(host!.querySelector('[data-note-id="moss"]')?.getAttribute('aria-current')).toBeNull()
  })

  it('shows the inbox view name and filters inline via the header input', async () => {
    const { vault } = await mountNoteList()
    await act(async () => {
      vault.listFilter = 'all'
      vault.searchQuery = ''
      vault.searchHits = []
      vault.notes = [noteWithBody('a', '会议纪要', '正文'), noteWithBody('b', 'Shopping', 'milk')]
    })
    expect(host!.querySelector('[data-testid="list-filter-clear"]')).toBeNull()
    const input = host!.querySelector<HTMLInputElement>('[data-testid="list-filter"]')!
    expect(input.placeholder).toBe('过滤标题或属性')
    await act(async () => {
      setInputValue(input, '纪要')
    })
    expect(itemTitles()).toEqual(['会议纪要'])
    expect(host!.querySelector('[data-testid="list-filter-clear"]')).not.toBeNull()
    await act(async () => {
      host!.querySelector<HTMLButtonElement>('[data-testid="list-filter-clear"]')!.click()
    })
    expect(itemTitles()).toEqual(['会议纪要', 'Shopping'])

    await act(async () => {
      vault.listFilter = 'inbox'
    })
    expect(noteListTitle(vault)).toBe('Inbox')
  })

  it('renders a quiet empty state when nothing matches', async () => {
    const { vault } = await mountNoteList()
    await act(async () => {
      vault.listFilter = 'all'
      vault.searchQuery = ''
      vault.searchHits = []
      vault.notes = []
    })
    expect(host!.querySelector('[data-testid="note-list-item"]')).toBeNull()
    expect(host!.querySelector('.note-list-empty')).not.toBeNull()
    expect(host!.querySelector('[data-testid="note-list-count"]')?.textContent).toBe('0')
  })
})
