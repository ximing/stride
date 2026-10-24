import { createNote, type StrideNote } from '@stride/core/note'
import { describe, expect, it } from 'vitest'
import { filterNotes } from '../search/list-filter'
import {
  DEFAULT_LIST_SORT,
  LIST_STORAGE_KEY,
  NOTE_ROW_HEIGHT,
  NOTE_ROW_HEIGHT_COMPACT,
  NOTE_ROW_OVERSCAN,
  noteCreatedMs,
  rangeSelection,
  readVaultSort,
  sanitizeListSort,
  sortNotes,
  toggleInSelection,
  virtualWindow,
  writeVaultSort,
  type ListStorage,
} from './note-list'

function makeNotes(count: number): StrideNote[] {
  return Array.from({ length: count }, (_, index) => {
    const note = createNote(`note-${index}`, `Note ${index} garden ledger`)
    note.properties = { status: index % 3 === 0 ? 'Open' : 'Done', views: index }
    note.doc = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: note.title }] },
        { type: 'paragraph', content: [{ type: 'text', text: `body of note ${index} with some words` }] },
      ],
    }
    return note
  })
}

function fakeStorage(): ListStorage & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => { data.set(key, value) },
  }
}

describe('virtualWindow', () => {
  it('renders the viewport rows plus overscan at the top of the list', () => {
    const win = virtualWindow(10000, 0, 660)
    expect(win.start).toBe(0)
    expect(win.end).toBe(Math.ceil(660 / NOTE_ROW_HEIGHT) + 6)
    expect(win.topPad).toBe(0)
    expect(win.bottomPad).toBe((10000 - win.end) * NOTE_ROW_HEIGHT)
  })

  it('windows the middle of a long list with constant DOM size', () => {
    const win = virtualWindow(10000, NOTE_ROW_HEIGHT * 5000, 660)
    expect(win.start).toBe(5000 - 6)
    expect(win.end).toBe(5000 + Math.ceil(660 / NOTE_ROW_HEIGHT) + 6)
    expect(win.end - win.start).toBe(Math.ceil(660 / NOTE_ROW_HEIGHT) + 12)
    expect(win.topPad).toBe(win.start * NOTE_ROW_HEIGHT)
    expect(win.bottomPad).toBe((10000 - win.end) * NOTE_ROW_HEIGHT)
  })

  it('clamps to the end of the list', () => {
    const win = virtualWindow(100, NOTE_ROW_HEIGHT * 1000, 660)
    expect(win.end).toBe(100)
    expect(win.bottomPad).toBe(0)
    // Max scrollTop is (100*H - 660); first visible row minus 6 overscan.
    expect(win.start).toBe(100 - Math.ceil(660 / NOTE_ROW_HEIGHT) - 6)
  })

  it('handles empty lists and garbage inputs', () => {
    expect(virtualWindow(0, 100, 600)).toEqual({ start: 0, end: 0, topPad: 0, bottomPad: 0 })
    const win = virtualWindow(10, Number.NaN, Number.NaN)
    expect(win.start).toBe(0)
    expect(win.end).toBe(6)
  })

  it('honors a compact row height (T7.3 per-vault density)', () => {
    const win = virtualWindow(10000, 0, 660, NOTE_ROW_OVERSCAN, NOTE_ROW_HEIGHT_COMPACT)
    expect(win.start).toBe(0)
    expect(win.end).toBe(Math.ceil(660 / NOTE_ROW_HEIGHT_COMPACT) + 6)
    expect(win.bottomPad).toBe((10000 - win.end) * NOTE_ROW_HEIGHT_COMPACT)

    // Same scroll pixel offset selects more rows in compact mode.
    const comfortable = virtualWindow(10000, NOTE_ROW_HEIGHT * 100, 660)
    const compact = virtualWindow(10000, NOTE_ROW_HEIGHT * 100, 660, NOTE_ROW_OVERSCAN, NOTE_ROW_HEIGHT_COMPACT)
    expect(compact.start).toBeGreaterThan(comfortable.start)
    expect(compact.topPad).toBe(compact.start * NOTE_ROW_HEIGHT_COMPACT)
  })
})

describe('sortNotes', () => {
  const mtimes = { a: 100, b: 300, c: 200 }

  it('sorts by mtime in both directions, missing mtimes last in desc', () => {
    const notes = [createNote('a', 'A'), createNote('b', 'B'), createNote('c', 'C'), createNote('d', 'D')]
    expect(sortNotes(notes, { key: 'mtime', dir: 'desc' }, mtimes).map((note) => note.id)).toEqual(['b', 'c', 'a', 'd'])
    expect(sortNotes(notes, { key: 'mtime', dir: 'asc' }, mtimes).map((note) => note.id)).toEqual(['d', 'a', 'c', 'b'])
  })

  it('sorts by title case-insensitively and stably', () => {
    const notes = [createNote('a', 'banana'), createNote('b', 'Apple'), createNote('c', 'apple')]
    expect(sortNotes(notes, { key: 'title', dir: 'asc' }, {}).map((note) => note.id)).toEqual(['b', 'c', 'a'])
    expect(sortNotes(notes, { key: 'title', dir: 'desc' }, {}).map((note) => note.id)).toEqual(['a', 'b', 'c'])
  })

  it('sorts by created property with mtime fallback', () => {
    const a = createNote('a', 'A')
    a.properties = { created: '2024-01-01' }
    const b = createNote('b', 'B') // no created → mtime fallback
    const c = createNote('c', 'C')
    c.properties = { created: 1_700_000_000_000 }
    const sorted = sortNotes([a, b, c], { key: 'created', dir: 'desc' }, { b: 1_800_000_000_000 })
    expect(sorted.map((note) => note.id)).toEqual(['b', 'a', 'c'])
  })

  it('does not mutate the input array', () => {
    const notes = [createNote('a', 'A'), createNote('b', 'B')]
    const before = [...notes]
    sortNotes(notes, { key: 'title', dir: 'desc' }, {})
    expect(notes).toEqual(before)
  })
})

describe('noteCreatedMs', () => {
  it('parses ISO strings and epoch numbers, falls back to mtime', () => {
    const note = createNote('x', 'X')
    note.properties = { created: '2026-01-15' }
    expect(noteCreatedMs(note, {})).toBe(Date.parse('2026-01-15'))
    note.properties = { created: 123_456 }
    expect(noteCreatedMs(note, {})).toBe(123_456)
    note.properties = { created: 'not a date' }
    expect(noteCreatedMs(note, { x: 77 })).toBe(77)
    note.properties = {}
    expect(noteCreatedMs(note, {})).toBe(0)
  })
})

describe('selection state machine', () => {
  it('toggles ids in and out', () => {
    expect(toggleInSelection([], 'a')).toEqual(['a'])
    expect(toggleInSelection(['a', 'b'], 'a')).toEqual(['b'])
    expect(toggleInSelection(['a'], 'b')).toEqual(['a', 'b'])
  })

  it('computes inclusive ranges in list order, both directions', () => {
    const order = ['a', 'b', 'c', 'd', 'e']
    expect(rangeSelection(order, 'b', 'd')).toEqual(['b', 'c', 'd'])
    expect(rangeSelection(order, 'd', 'b')).toEqual(['b', 'c', 'd'])
    expect(rangeSelection(order, 'b', 'b')).toEqual(['b'])
  })

  it('collapses gracefully when an endpoint is unknown', () => {
    const order = ['a', 'b']
    expect(rangeSelection(order, 'zzz', 'b')).toEqual(['b'])
    expect(rangeSelection(order, 'a', 'zzz')).toEqual(['a'])
    expect(rangeSelection(order, 'x', 'y')).toEqual([])
  })
})

describe('sort persistence', () => {
  it('round-trips a sort per vault in the versioned file', () => {
    const storage = fakeStorage()
    writeVaultSort(storage, 'vault-1', { key: 'title', dir: 'asc' })
    writeVaultSort(storage, 'vault-2', { key: 'created', dir: 'desc' })
    expect(readVaultSort(storage, 'vault-1')).toEqual({ key: 'title', dir: 'asc' })
    expect(readVaultSort(storage, 'vault-2')).toEqual({ key: 'created', dir: 'desc' })
    const file = JSON.parse(storage.data.get(LIST_STORAGE_KEY)!) as { version: number }
    expect(file.version).toBe(1)
  })

  it('returns the default for unknown vaults and garbage payloads', () => {
    const storage = fakeStorage()
    expect(readVaultSort(storage, 'nope')).toEqual(DEFAULT_LIST_SORT)
    storage.setItem(LIST_STORAGE_KEY, 'not json')
    expect(readVaultSort(storage, 'v')).toEqual(DEFAULT_LIST_SORT)
    storage.setItem(LIST_STORAGE_KEY, JSON.stringify({ version: 99, vaults: {} }))
    expect(readVaultSort(storage, 'v')).toEqual(DEFAULT_LIST_SORT)
    storage.setItem(LIST_STORAGE_KEY, JSON.stringify({ version: 1, vaults: { v: { sort: { key: 'bogus', dir: 'sideways' } } } }))
    expect(readVaultSort(storage, 'v')).toEqual(DEFAULT_LIST_SORT)
  })

  it('sanitizes partial sorts field by field', () => {
    expect(sanitizeListSort({ key: 'title' })).toEqual({ key: 'title', dir: DEFAULT_LIST_SORT.dir })
    expect(sanitizeListSort({ dir: 'asc' })).toEqual({ key: DEFAULT_LIST_SORT.key, dir: 'asc' })
    expect(sanitizeListSort(null)).toEqual(DEFAULT_LIST_SORT)
  })

  it('never throws when storage is unavailable', () => {
    expect(readVaultSort(null, 'v')).toEqual(DEFAULT_LIST_SORT)
    expect(() => writeVaultSort(null, 'v', { key: 'title', dir: 'asc' })).not.toThrow()
  })
})

describe('performance budget (10k notes)', () => {
  const notes = makeNotes(10_000)
  const mtimes: Record<string, number> = {}
  notes.forEach((note, index) => { mtimes[note.id] = index * 1000 })

  it('filters 10k notes within 50ms per keystroke', () => {
    // Warm up JIT so the measurement is steady-state, matching real typing.
    filterNotes(notes, 'garden')
    const started = performance.now()
    const hits = filterNotes(notes, 'garden')
    const elapsed = performance.now() - started
    expect(hits.length).toBeGreaterThan(0)
    expect(elapsed).toBeLessThan(50)
  })

  it('sorts 10k notes within 200ms', () => {
    sortNotes(notes, { key: 'mtime', dir: 'desc' }, mtimes)
    const started = performance.now()
    const sorted = sortNotes(notes, { key: 'mtime', dir: 'desc' }, mtimes)
    const elapsed = performance.now() - started
    expect(sorted.length).toBe(10_000)
    expect(elapsed).toBeLessThan(200)
  })

  it('window size stays constant regardless of list length', () => {
    const small = virtualWindow(50, 0, 660)
    const large = virtualWindow(50_000, 0, 660)
    expect(large.end - large.start).toBe(small.end - small.start)
  })
})
