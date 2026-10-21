import { describe, expect, it } from 'vitest'
import {
  closeTab,
  createTab,
  historyBack,
  historyForward,
  openOrFocus,
  pruneTabs,
  pushHistory,
  readVaultTabs,
  remapNoteId,
  sanitizeVaultTabs,
  TABS_STORAGE_KEY,
  writeVaultTabs,
  type TabState,
  type TabsStorage,
} from './tabs'

function tab(id: string, noteId: string, back: string[] = [], forward: string[] = []): TabState {
  return { id, noteId, back, forward }
}

function memoryStorage(): TabsStorage & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value)
    },
  }
}

describe('pushHistory', () => {
  it('moves the current note onto the back stack and clears forward', () => {
    const start = tab('t1', 'a', ['x'], ['y'])
    const next = pushHistory(start, 'b')
    expect(next).toEqual({ id: 't1', noteId: 'b', back: ['x', 'a'], forward: [] })
    // Input untouched.
    expect(start.noteId).toBe('a')
  })

  it('is a no-op for the current or empty note', () => {
    const start = tab('t1', 'a', ['x'])
    expect(pushHistory(start, 'a')).toBe(start)
    expect(pushHistory(start, '')).toBe(start)
  })
})

describe('historyBack / historyForward', () => {
  it('walks back and forward through the trail', () => {
    let current = createTab('a', 't1')
    current = pushHistory(current, 'b')
    current = pushHistory(current, 'c')
    const back1 = historyBack(current)
    expect(back1?.noteId).toBe('b')
    expect(back1?.forward).toEqual(['c'])
    const back2 = historyBack(back1!)
    expect(back2?.noteId).toBe('a')
    expect(back2?.forward).toEqual(['b', 'c'])
    expect(historyBack(back2!)).toBeNull()
    const fwd1 = historyForward(back2!)
    expect(fwd1?.noteId).toBe('b')
    const fwd2 = historyForward(fwd1!)
    expect(fwd2?.noteId).toBe('c')
    expect(historyForward(fwd2!)).toBeNull()
  })
})

describe('openOrFocus', () => {
  let seq = 0
  const makeId = () => `gen-${(seq += 1)}`

  it('appends a fresh tab for a note that is not open', () => {
    const result = openOrFocus([tab('t1', 'a')], 'b', makeId)
    expect(result.created).toBe(true)
    expect(result.tabs.map((item) => item.noteId)).toEqual(['a', 'b'])
    expect(result.tab.noteId).toBe('b')
    expect(result.tab.back).toEqual([])
  })

  it('focuses the existing tab instead of duplicating it', () => {
    const result = openOrFocus([tab('t1', 'a'), tab('t2', 'b')], 'a', makeId)
    expect(result.created).toBe(false)
    expect(result.tab.id).toBe('t1')
    expect(result.tabs.map((item) => item.id)).toEqual(['t1', 't2'])
  })
})

describe('closeTab', () => {
  const tabs = [tab('t1', 'a'), tab('t2', 'b'), tab('t3', 'c')]

  it('closing the active tab focuses the right neighbor', () => {
    const result = closeTab(tabs, 't2', 't2')
    expect(result.tabs.map((item) => item.id)).toEqual(['t1', 't3'])
    expect(result.activeTabId).toBe('t3')
  })

  it('closing the last tab falls back to the left neighbor', () => {
    const result = closeTab(tabs, 't3', 't3')
    expect(result.activeTabId).toBe('t2')
  })

  it('closing the only tab clears the active tab', () => {
    const result = closeTab([tab('t1', 'a')], 't1', 't1')
    expect(result.tabs).toEqual([])
    expect(result.activeTabId).toBe('')
  })

  it('closing a background tab keeps the active tab', () => {
    const result = closeTab(tabs, 't1', 't2')
    expect(result.tabs.map((item) => item.id)).toEqual(['t2', 't3'])
    expect(result.activeTabId).toBe('t2')
  })

  it('unknown tab ids are a no-op', () => {
    const result = closeTab(tabs, 'nope', 't2')
    expect(result.tabs.map((item) => item.id)).toEqual(['t1', 't2', 't3'])
    expect(result.activeTabId).toBe('t2')
  })
})

describe('remapNoteId', () => {
  it('rewrites the current note and both history stacks', () => {
    const tabs = [tab('t1', 'a', ['x', 'b'], ['c']), tab('t2', 'b')]
    const next = remapNoteId(tabs, 'b', 'b2')
    expect(next[0]).toEqual({ id: 't1', noteId: 'a', back: ['x', 'b2'], forward: ['c'] })
    expect(next[1]).toEqual({ id: 't2', noteId: 'b2', back: [], forward: [] })
  })

  it('ignores empty and identical ids', () => {
    const tabs = [tab('t1', 'a')]
    expect(remapNoteId(tabs, '', 'x')[0]?.noteId).toBe('a')
    expect(remapNoteId(tabs, 'a', 'a')[0]?.noteId).toBe('a')
  })
})

describe('pruneTabs', () => {
  it('drops tabs whose note is gone and scrubs dead history entries', () => {
    const alive = new Set(['a', 'c'])
    const tabs = [tab('t1', 'a', ['x', 'c'], ['y']), tab('t2', 'dead')]
    const next = pruneTabs(tabs, (id) => alive.has(id))
    expect(next).toEqual([{ id: 't1', noteId: 'a', back: ['c'], forward: [] }])
  })
})

describe('sanitizeVaultTabs', () => {
  it('accepts a well-formed scene and dedupes tab ids', () => {
    expect(sanitizeVaultTabs({ tabs: ['a', 'b', 'a'], active: 'b' })).toEqual({ tabs: ['a', 'b'], active: 'b' })
  })

  it('rejects garbage', () => {
    expect(sanitizeVaultTabs(null)).toBeNull()
    expect(sanitizeVaultTabs('tabs')).toBeNull()
    expect(sanitizeVaultTabs({ tabs: 'a' })).toBeNull()
    expect(sanitizeVaultTabs({ tabs: ['a', 1] })).toBeNull()
    expect(sanitizeVaultTabs({ tabs: [] })).toEqual({ tabs: [], active: '' })
  })
})

describe('readVaultTabs / writeVaultTabs', () => {
  it('round-trips a scene and isolates vaults from each other', () => {
    const storage = memoryStorage()
    writeVaultTabs(storage, 'vault-1', { tabs: ['a', 'b'], active: 'b' })
    writeVaultTabs(storage, 'vault-2', { tabs: ['z'], active: 'z' })
    expect(readVaultTabs(storage, 'vault-1')).toEqual({ tabs: ['a', 'b'], active: 'b' })
    expect(readVaultTabs(storage, 'vault-2')).toEqual({ tabs: ['z'], active: 'z' })
    expect(readVaultTabs(storage, 'missing')).toBeNull()
    // The file stays versioned.
    const raw = JSON.parse(storage.data.get(TABS_STORAGE_KEY)!) as { version: number }
    expect(raw.version).toBe(1)
  })

  it('tolerates garbage JSON and wrong versions', () => {
    const storage = memoryStorage()
    storage.setItem(TABS_STORAGE_KEY, 'not json')
    expect(readVaultTabs(storage, 'vault-1')).toBeNull()
    storage.setItem(TABS_STORAGE_KEY, JSON.stringify({ version: 99, vaults: { 'vault-1': { tabs: ['a'], active: 'a' } } }))
    expect(readVaultTabs(storage, 'vault-1')).toBeNull()
    // A bad scene entry is dropped without breaking sibling vaults.
    storage.setItem(
      TABS_STORAGE_KEY,
      JSON.stringify({ version: 1, vaults: { bad: { tabs: 'oops' }, good: { tabs: ['a'], active: '' } } }),
    )
    expect(readVaultTabs(storage, 'bad')).toBeNull()
    expect(readVaultTabs(storage, 'good')).toEqual({ tabs: ['a'], active: '' })
  })

  it('no-ops without storage or vault id', () => {
    const storage = memoryStorage()
    writeVaultTabs(null, 'vault-1', { tabs: ['a'], active: 'a' })
    writeVaultTabs(storage, '', { tabs: ['a'], active: 'a' })
    expect(readVaultTabs(null, 'vault-1')).toBeNull()
    expect(storage.data.size).toBe(0)
    expect(readVaultTabs(storage, '')).toBeNull()
  })
})
