import { has, register, resolve } from '@rabjs/react'
import { createNote } from '@stride/core/note'
import { MemoryFileSystem } from '@stride/platform'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { initializeVault } from '../../../../../packages/core/src/seed'
import { createVaultNote } from '../../../../../packages/core/src/vault'
import { ListFilterService } from '../../services/search/list-filter.service'
import { DEFAULT_LIST_SORT, LIST_STORAGE_KEY, NOTE_ROW_HEIGHT } from '../../services/notes/note-list'
import { NoteListService } from '../../services/notes/note-list.service'
import { FolderService } from '../../services/vault/folder.service'
import { VaultService } from '../../services/vault/vault.service'
import { NoteList, noteListTitle, noteSnippet, noteTags, relativeDay } from './note-list'

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

async function mountNoteList(): Promise<{ vault: VaultService; list: NoteListService }> {
  useMemoryFixture()
  vi.stubGlobal('showDirectoryPicker', vi.fn())
  register(VaultService)
  if (!has(ListFilterService)) register(ListFilterService)
  resolve(ListFilterService).clear()
  const list = resolve(NoteListService)
  list.clearSelection()
  list.sort = { ...DEFAULT_LIST_SORT }
  const vault = resolve(VaultService)
  vault.cancelPending()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root?.render(<NoteList />)
  })
  return { vault, list }
}

function itemTitles(): string[] {
  return [...host!.querySelectorAll('[data-testid="note-list-item"] .note-list-item-title')]
    .map((node) => node.textContent ?? '')
}

function renderedItems(): HTMLElement[] {
  return [...host!.querySelectorAll<HTMLElement>('[data-testid="note-list-item"]')]
}

function clickRow(id: string, mods: { shiftKey?: boolean; metaKey?: boolean } = {}) {
  const row = host!.querySelector<HTMLElement>(`[data-note-id="${id}"]`)!
  row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...mods }))
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

describe('noteTags', () => {
  it('reads arrays and comma-separated strings, trimming blanks', () => {
    const note = createNote('t', 'T')
    expect(noteTags(note)).toEqual([])
    note.properties = { tags: [' alpha ', '', 'beta'] }
    expect(noteTags(note)).toEqual(['alpha', 'beta'])
    note.properties = { tags: 'one, two，three' }
    expect(noteTags(note)).toEqual(['one', 'two', 'three'])
    note.properties = { tags: 'solo' }
    expect(noteTags(note)).toEqual(['solo'])
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
    const list = resolve(NoteListService)
    list.clearSelection()
    list.sort = { ...DEFAULT_LIST_SORT }
    localStorage.removeItem(LIST_STORAGE_KEY)
    window.history.replaceState(null, '', '/')
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    try {
      resolve(VaultService).cancelPending()
    } catch {
      // not registered in pure-helper-only runs
    }
  })

  it('scopes the list to a folder filter and the header + creates inside it', async () => {
    if (!has(FolderService)) register(FolderService)
    const { vault } = await mountNoteList()
    await act(async () => {
      await vault.openFromDraft()
      await vault.createNote()
    })
    const rootId = vault.activeId
    await act(async () => {
      await resolve(FolderService).createFolder('box')
      vault.setFilter('folder:box')
    })
    // The root note is out of scope; the header shows the folder name.
    expect(renderedItems().length).toBe(0)
    expect(host!.querySelector('[data-testid="note-list-title"]')?.textContent).toBe('box')

    await act(async () => {
      host!.querySelector<HTMLButtonElement>('[data-testid="note-list-new"]')!.click()
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 0))
    })
    expect(vault.activeId.startsWith('box/')).toBe(true)
    // The folder scope survives createNote()'s reset-to-all.
    expect(vault.listFilter).toBe('folder:box')
    expect(vault.visibleNotes.map((note) => note.id)).not.toContain(rootId)
    expect(itemTitles()).toEqual([vault.active?.title ?? ''])
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

  it('opens a list filter from the header icon and filters the notes', async () => {
    const { vault } = await mountNoteList()
    await act(async () => {
      vault.listFilter = 'all'
      vault.searchQuery = ''
      vault.searchHits = []
      vault.notes = [noteWithBody('a', '会议纪要', '正文'), noteWithBody('b', 'Shopping', 'milk')]
    })
    const toggle = host!.querySelector<HTMLButtonElement>('[data-testid="list-filter-toggle"]')!
    expect(toggle.getAttribute('aria-label')).toBe('Filter list')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(host!.querySelector('[data-testid="list-filter"]')).toBeNull()
    expect(host!.querySelector('[data-testid="list-filter-clear"]')).toBeNull()

    await act(async () => {
      toggle.click()
    })
    const input = host!.querySelector<HTMLInputElement>('[data-testid="list-filter"]')!
    expect(input.placeholder).toBe('Filter title or properties')
    expect(host!.querySelector('[data-testid="list-filter-toggle"]')?.getAttribute('aria-expanded')).toBe('true')
    await act(async () => {
      setInputValue(input, '纪要')
    })
    expect(itemTitles()).toEqual(['会议纪要'])
    expect(host!.querySelector('[data-testid="list-filter-clear"]')).not.toBeNull()
    // A typed query stays visible; the icon focuses the field instead of hiding it.
    await act(async () => {
      host!.querySelector<HTMLButtonElement>('[data-testid="list-filter-toggle"]')!.click()
    })
    expect(host!.querySelector('[data-testid="list-filter"]')).not.toBeNull()
    await act(async () => {
      host!.querySelector<HTMLButtonElement>('[data-testid="list-filter-clear"]')!.click()
    })
    expect(itemTitles()).toEqual(['会议纪要', 'Shopping'])
    expect(host!.querySelector('[data-testid="list-filter"]')).not.toBeNull()
    await act(async () => {
      host!.querySelector<HTMLButtonElement>('[data-testid="list-filter-toggle"]')!.click()
    })
    expect(host!.querySelector('[data-testid="list-filter"]')).toBeNull()

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
    expect(host!.querySelector('[data-testid="note-list-empty-vault"]')).not.toBeNull()
    expect(host!.querySelector('[data-testid="note-list-count"]')?.textContent).toBe('0')
  })

  it('says when the inline filter matches nothing', async () => {
    const { vault } = await mountNoteList()
    await act(async () => {
      vault.listFilter = 'all'
      vault.searchQuery = ''
      vault.searchHits = []
      vault.notes = [noteWithBody('a', 'Alpha', 'body')]
    })
    await act(async () => {
      host!.querySelector<HTMLButtonElement>('[data-testid="list-filter-toggle"]')!.click()
    })
    const input = host!.querySelector<HTMLInputElement>('[data-testid="list-filter"]')!
    await act(async () => {
      setInputValue(input, 'zzz')
    })
    expect(host!.querySelector('[data-testid="note-list-empty-filter"]')?.textContent).toContain('No notes match “zzz”.')
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(host!.querySelector('[data-testid="list-filter"]')).toBeNull()
    expect(itemTitles()).toEqual(['Alpha'])
  })

  it('renders type and status chips; plain notes get no type chip', async () => {
    const { vault } = await mountNoteList()
    const typeDoc = createNote('type-project', 'Project')
    typeDoc.type = 'Type'
    typeDoc.properties = { _color: 'blue', _sidebar_label: 'Projects' }
    const typed = noteWithBody('p1', 'Launch plan', 'body')
    typed.type = 'Project'
    typed.properties = { status: 'Open' }
    const plain = noteWithBody('n1', 'Loose note', 'body')
    await act(async () => {
      vault.listFilter = 'all'
      vault.searchQuery = ''
      vault.searchHits = []
      vault.notes = [typeDoc, typed, plain]
    })
    const chip = host!.querySelector('[data-note-id="p1"] [data-testid="note-chip-type"]')!
    expect(chip.querySelector('.type-dot')?.className).toContain('type-dot-blue')
    expect(chip.querySelector('.note-chip-label')?.textContent).toBe('Projects')
    expect(host!.querySelector('[data-note-id="p1"] [data-testid="note-chip-status"]')?.textContent).toBe('Open')
    expect(host!.querySelector('[data-note-id="n1"] [data-testid="note-chip-type"]')).toBeNull()
    expect(host!.querySelector('[data-note-id="n1"] [data-testid="note-chip-status"]')).toBeNull()
  })

  it('renders every tag chip (no truncation) and tones the status chip', async () => {
    const { vault } = await mountNoteList()
    const tagged = noteWithBody('t1', 'Tagged', 'body')
    tagged.properties = { tags: ['alpha', 'beta', 'gamma'], status: 'draft' }
    const csv = noteWithBody('t2', 'Csv tags', 'body')
    csv.properties = { tags: 'x, y' }
    await act(async () => {
      vault.listFilter = 'all'
      vault.searchQuery = ''
      vault.searchHits = []
      vault.notes = [tagged, csv]
    })
    const tagTexts = (id: string) =>
      [...host!.querySelectorAll(`[data-note-id="${id}"] [data-testid="note-chip-tag"]`)].map((n) => n.textContent)
    expect(tagTexts('t1')).toEqual(['#alpha', '#beta', '#gamma'])
    expect(tagTexts('t2')).toEqual(['#x', '#y'])
    expect(host!.querySelector('[data-note-id="t1"] [data-testid="note-chip-status"]')?.className).toContain('is-draft')
  })

  it('lays out three rows: title, a collapsible snippet line, then the meta row', async () => {
    const { vault } = await mountNoteList()
    const withBody = noteWithBody('wb', 'Has body', 'A snippet worth reading.')
    const empty = createNote('eb', 'Empty note')
    await act(async () => {
      vault.listFilter = 'all'
      vault.searchQuery = ''
      vault.searchHits = []
      vault.notes = [withBody, empty]
    })
    const fullRow = host!.querySelector('[data-note-id="wb"]')!
    // Title, snippet, meta are three sibling lines inside the row.
    const lines = [...fullRow.children].map((node) => (node as HTMLElement).className)
    expect(lines[0]).toContain('note-list-item-title')
    expect(lines[1]).toContain('note-list-item-snippet')
    expect(lines[2]).toContain('note-list-item-meta')
    expect(fullRow.querySelector('[data-testid="note-list-item-snippet"]')?.textContent).toBe('A snippet worth reading.')
    // The snippet sits on its own line, outside the meta row.
    expect(fullRow.querySelector('.note-list-item-meta [data-testid="note-list-item-snippet"]')).toBeNull()
    // No body → the snippet line collapses instead of rendering an empty span.
    const emptyRow = host!.querySelector('[data-note-id="eb"]')!
    expect(emptyRow.querySelector('[data-testid="note-list-item-snippet"]')).toBeNull()
    expect(emptyRow.parentElement?.className).toContain('is-title')
    expect(emptyRow.querySelector('.note-list-item-meta')).toBeNull()
    expect(fullRow.parentElement?.className).not.toContain('is-empty')
  })

  it('tints tag chips by name hash and recolors them from the chip context menu', async () => {
    const { vault } = await mountNoteList()
    const tagged = noteWithBody('t1', 'Tagged', 'body')
    tagged.properties = { tags: ['alpha'] }
    await act(async () => {
      vault.listFilter = 'all'
      vault.searchQuery = ''
      vault.searchHits = []
      vault.notes = [tagged]
    })
    const chip = () => host!.querySelector<HTMLElement>('[data-note-id="t1"] [data-testid="note-chip-tag"]')!
    // Default: deterministic name hash (never gray).
    expect(chip().style.getPropertyValue('--chip-hue')).toBe(`var(--sd-dot-${vault.tagColorFor('alpha')})`)

    // Right-click the chip: 8 colors + auto, no row menu, no selection change.
    await act(async () => {
      chip().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }))
    })
    expect(document.querySelector('[data-testid="context-menu-item-tag-color-blue"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="context-menu-item-tag-color-auto"]')).not.toBeNull()
    await act(async () => {
      document.querySelector<HTMLElement>('[data-testid="context-menu-item-tag-color-pink"]')!.click()
    })
    expect(vault.tagColors.alpha).toBe('pink')
    expect(chip().style.getPropertyValue('--chip-hue')).toBe('var(--sd-dot-pink)')

    // Back to auto: the explicit entry is dropped and the hash color returns.
    await act(async () => {
      chip().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }))
    })
    await act(async () => {
      document.querySelector<HTMLElement>('[data-testid="context-menu-item-tag-color-auto"]')!.click()
    })
    expect(vault.tagColors.alpha).toBeUndefined()
    expect(chip().style.getPropertyValue('--chip-hue')).toBe(`var(--sd-dot-${vault.tagColorFor('alpha')})`)
  })

  it('shows a process button only in the inbox and marking hides the row', async () => {
    const { vault } = await mountNoteList()
    const loose = noteWithBody('loose', 'Loose', 'body')
    const linked = noteWithBody('linked', 'Linked', 'body')
    linked.properties = { belongs_to: ['[[Loose]]'] }
    await act(async () => {
      vault.searchQuery = ''
      vault.searchHits = []
      vault.notes = [loose, linked]
      vault.listFilter = 'all'
    })
    // The "all" view never shows the process button.
    expect(host!.querySelector('[data-note-id="loose"] [data-testid="note-process"]')).toBeNull()
    // jsdom has no layout; query from the row wrapper instead of the row button.
    expect(host!.querySelector('[data-note-id="loose"]')?.parentElement?.querySelector('[data-testid="note-process"]')).toBeNull()

    await act(async () => {
      vault.listFilter = 'inbox'
    })
    // Only the unlinked note is in the inbox, and its row has the button.
    expect(renderedItems().map((row) => row.dataset.noteId)).toEqual(['loose'])
    const button = host!.querySelector('[data-note-id="loose"]')!.parentElement!
      .querySelector<HTMLButtonElement>('[data-testid="note-process"]')!
    expect(button.getAttribute('aria-label')).toBe('Mark processed')

    await act(async () => {
      button.click()
    })
    // _processed flag set, inbox re-derived → the row leaves the list.
    expect(vault.notes.find((note) => note.id === 'loose')?.properties._processed).toBe(true)
    expect(renderedItems().length).toBe(0)
    // The click did not select or open the note.
    expect(vault.activeId).not.toBe('loose')

    // Back in "all" the processed note is still listed, without a badge.
    await act(async () => {
      vault.listFilter = 'all'
    })
    expect(renderedItems().map((row) => row.dataset.noteId).sort()).toEqual(['linked', 'loose'])
    expect(host!.querySelector('[data-note-id="loose"]')?.parentElement?.querySelector('[data-testid="note-process"]')).toBeNull()
  })

  it('multi-selects with Mod+click and Shift+click, clears with Esc', async () => {
    const { vault, list } = await mountNoteList()
    await act(async () => {
      vault.listFilter = 'all'
      vault.searchQuery = ''
      vault.searchHits = []
      vault.notes = [noteWithBody('a', 'A', 'x'), noteWithBody('b', 'B', 'x'), noteWithBody('c', 'C', 'x')]
    })
    expect(host!.querySelector('[data-testid="note-list-batch"]')).toBeNull()

    await act(async () => { clickRow('a') })
    expect(list.selectedIds).toEqual(['a'])
    expect(vault.activeId).toBe('a')
    expect(host!.querySelector('[data-testid="note-list-batch"]')).toBeNull()

    await act(async () => { clickRow('c', { metaKey: true }) })
    expect(list.selectedIds).toEqual(['a', 'c'])
    expect(host!.querySelector('[data-testid="note-list-batch-count"]')?.textContent).toBe('2 selected')
    const batch = host!.querySelector('[data-testid="note-list-batch"]')!
    expect(batch.querySelector('.note-list-batch-head [data-testid="batch-clear"]')).not.toBeNull()
    expect(batch.querySelector('.note-list-batch-actions [data-testid="batch-archive"]')).not.toBeNull()
    expect(batch.querySelector('.note-list-batch-actions [data-testid="batch-delete"]')).not.toBeNull()
    expect(host!.querySelector('[data-note-id="a"]')?.getAttribute('data-selected')).toBe('true')
    expect(host!.querySelector('[data-note-id="b"]')?.getAttribute('data-selected')).toBeNull()

    // Shift+click ranges from the anchor (a) over the rendered order.
    await act(async () => { clickRow('a') })
    await act(async () => { clickRow('c', { shiftKey: true }) })
    expect(list.selectedIds).toEqual(['a', 'b', 'c'])

    await act(async () => {
      host!.querySelector('[data-note-id="b"]')!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      )
    })
    expect(list.selectedIds).toEqual([])
    expect(host!.querySelector('[data-testid="note-list-batch"]')).toBeNull()
  })

  it('batch-archives the selection through the vault', async () => {
    const { vault, list } = await mountNoteList()
    await act(async () => {
      await vault.openFromDraft()
      await vault.createNote()
      await vault.createNote()
    })
    const ids = vault.notes.map((note) => note.id)
    expect(ids.length).toBe(2)
    await act(async () => { clickRow(ids[0]!) })
    await act(async () => { clickRow(ids[1]!, { metaKey: true }) })
    expect(list.hasMultiSelection).toBe(true)

    await act(async () => {
      host!.querySelector<HTMLButtonElement>('[data-testid="batch-archive"]')!.click()
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 0))
    })
    expect(vault.notes.every((note) => note.properties.archived === true)).toBe(true)
    expect(renderedItems().length).toBe(0)
    expect(list.selectionCount).toBe(0)
  })

  it('batch-deletes the selection after modal confirmation', async () => {
    const { vault, list } = await mountNoteList()
    await act(async () => {
      await vault.openFromDraft()
      await vault.createNote()
      await vault.createNote()
    })
    const ids = vault.notes.map((note) => note.id)
    await act(async () => { clickRow(ids[0]!) })
    await act(async () => { clickRow(ids[1]!, { metaKey: true }) })

    await act(async () => {
      host!.querySelector<HTMLButtonElement>('[data-testid="batch-delete"]')!.click()
    })
    expect(list.confirmingDelete).toBe(true)

    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-testid="confirm-delete"]')!.click()
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 0))
    })
    expect(vault.notes.length).toBe(0)
    expect(list.confirmingDelete).toBe(false)
    expect(list.selectionCount).toBe(0)
  })

  it('sorts by title through the header sort menu', async () => {
    const { vault } = await mountNoteList()
    await act(async () => {
      vault.listFilter = 'all'
      vault.searchQuery = ''
      vault.searchHits = []
      vault.notes = [noteWithBody('a', 'banana', 'x'), noteWithBody('b', 'Apple', 'x')]
      vault.noteMtimes = {}
    })
    expect(itemTitles()).toEqual(['banana', 'Apple'])

    await act(async () => {
      host!.querySelector<HTMLElement>('[data-testid="note-list-sort"]')!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      )
    })
    const item = document.querySelector<HTMLElement>('[data-testid="sort-title-asc"]')
    expect(item).not.toBeNull()
    await act(async () => {
      item!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    expect(itemTitles()).toEqual(['Apple', 'banana'])
  })

  it('renders only a window of rows and moves it on scroll', async () => {
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(NOTE_ROW_HEIGHT * 2)
    const { vault } = await mountNoteList()
    const notes = Array.from({ length: 100 }, (_, index) => noteWithBody(`n${index}`, `Note ${index}`, 'x'))
    const mtimes: Record<string, number> = {}
    notes.forEach((note, index) => { mtimes[note.id] = (100 - index) * 1000 })
    await act(async () => {
      vault.listFilter = 'all'
      vault.searchQuery = ''
      vault.searchHits = []
      vault.notes = notes
      vault.noteMtimes = mtimes
    })
    // 2 visible rows + 6 overscan below: 8 DOM rows for 100 notes.
    expect(renderedItems().length).toBe(8)
    expect(renderedItems()[0]!.dataset.noteId).toBe('n0')

    const scroller = host!.querySelector<HTMLElement>('[data-testid="note-list-items"]')!
    await act(async () => {
      scroller.scrollTop = NOTE_ROW_HEIGHT * 50
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }))
    })
    const rendered = renderedItems()
    expect(rendered.length).toBe(14) // 6 above + 2 visible + 6 below
    expect(rendered[0]!.dataset.noteId).toBe('n44')
    expect(rendered[rendered.length - 1]!.dataset.noteId).toBe('n57')
  })
})
