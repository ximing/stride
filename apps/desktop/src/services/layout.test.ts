import { beforeEach, describe, expect, it } from 'vitest'
import {
  clampColumnWidth,
  COLUMN_LIMITS,
  DEFAULT_LAYOUT_STATE,
  LAYOUT_STORAGE_KEY,
  readLayoutState,
  sanitizeLayoutState,
  writeLayoutState,
  type LayoutStorage,
} from './layout'
import { LayoutService } from './layout.service'

function memoryStorage(initial: Record<string, string> = {}): LayoutStorage & { data: Record<string, string> } {
  const data = { ...initial }
  return {
    data,
    getItem: (key) => (key in data ? data[key]! : null),
    setItem: (key, value) => {
      data[key] = value
    },
  }
}

describe('clampColumnWidth', () => {
  it('clamps below min and above max', () => {
    expect(clampColumnWidth('sidebar', 10)).toBe(COLUMN_LIMITS.sidebar.min)
    expect(clampColumnWidth('sidebar', 9999)).toBe(COLUMN_LIMITS.sidebar.max)
    expect(clampColumnWidth('noteList', 260)).toBe(260)
    expect(clampColumnWidth('rightPanel', -5)).toBe(COLUMN_LIMITS.rightPanel.min)
  })

  it('rounds fractional widths and falls back on garbage', () => {
    expect(clampColumnWidth('sidebar', 231.6)).toBe(232)
    expect(clampColumnWidth('noteList', Number.NaN)).toBe(DEFAULT_LAYOUT_STATE.noteListWidth)
    expect(clampColumnWidth('rightPanel', Number.POSITIVE_INFINITY)).toBe(DEFAULT_LAYOUT_STATE.rightPanelWidth)
  })
})

describe('sanitizeLayoutState', () => {
  it('returns defaults for non-objects', () => {
    expect(sanitizeLayoutState(null)).toEqual(DEFAULT_LAYOUT_STATE)
    expect(sanitizeLayoutState('broken')).toEqual(DEFAULT_LAYOUT_STATE)
    expect(sanitizeLayoutState(42)).toEqual(DEFAULT_LAYOUT_STATE)
  })

  it('keeps valid fields and repairs invalid ones', () => {
    const state = sanitizeLayoutState({
      sidebarWidth: 300,
      noteListWidth: 99999,
      rightPanelWidth: 'wide',
      sidebarCollapsed: true,
      rightPanelCollapsed: 1,
      rightPanelTab: 'chat',
    })
    expect(state.sidebarWidth).toBe(300)
    expect(state.noteListWidth).toBe(COLUMN_LIMITS.noteList.max)
    expect(state.rightPanelWidth).toBe(DEFAULT_LAYOUT_STATE.rightPanelWidth)
    expect(state.sidebarCollapsed).toBe(true)
    expect(state.rightPanelCollapsed).toBe(false)
    expect(state.rightPanelTab).toBe('chat')
  })

  it('rejects unknown tab names', () => {
    expect(sanitizeLayoutState({ rightPanelTab: 'terminal' }).rightPanelTab).toBe('properties')
  })
})

describe('readLayoutState / writeLayoutState', () => {
  it('returns defaults when storage is missing or empty', () => {
    expect(readLayoutState(null)).toEqual(DEFAULT_LAYOUT_STATE)
    expect(readLayoutState(memoryStorage())).toEqual(DEFAULT_LAYOUT_STATE)
  })

  it('survives corrupt JSON', () => {
    const storage = memoryStorage({ [LAYOUT_STORAGE_KEY]: '{nope' })
    expect(readLayoutState(storage)).toEqual(DEFAULT_LAYOUT_STATE)
  })

  it('round-trips a state', () => {
    const storage = memoryStorage()
    const state = {
      ...DEFAULT_LAYOUT_STATE,
      sidebarWidth: 200,
      rightPanelCollapsed: true,
      rightPanelTab: 'git' as const,
    }
    writeLayoutState(storage, state)
    expect(readLayoutState(storage)).toEqual(state)
  })

  it('sanitizes on write', () => {
    const storage = memoryStorage()
    writeLayoutState(storage, { ...DEFAULT_LAYOUT_STATE, sidebarWidth: 1 })
    expect(readLayoutState(storage).sidebarWidth).toBe(COLUMN_LIMITS.sidebar.min)
  })

  it('never throws when storage throws', () => {
    const throwing: LayoutStorage = {
      getItem() {
        throw new Error('denied')
      },
      setItem() {
        throw new Error('denied')
      },
    }
    expect(readLayoutState(throwing)).toEqual(DEFAULT_LAYOUT_STATE)
    expect(() => writeLayoutState(throwing, DEFAULT_LAYOUT_STATE)).not.toThrow()
  })
})

describe('LayoutService', () => {
  beforeEach(() => {
    localStorage.removeItem(LAYOUT_STORAGE_KEY)
  })

  it('persists width, collapse, and tab changes to localStorage', () => {
    const layout = new LayoutService()
    layout.setColumnWidth('noteList', 300)
    layout.setSidebarCollapsed(true)
    layout.setRightPanelTab('chat')
    const stored = readLayoutState(localStorage)
    expect(stored.noteListWidth).toBe(300)
    expect(stored.sidebarCollapsed).toBe(true)
    expect(stored.rightPanelTab).toBe('chat')
    expect(stored.rightPanelCollapsed).toBe(false)
  })

  it('restores persisted state in a new instance', () => {
    writeLayoutState(localStorage, {
      ...DEFAULT_LAYOUT_STATE,
      sidebarWidth: 210,
      rightPanelCollapsed: true,
      rightPanelTab: 'settings',
    })
    const layout = new LayoutService()
    expect(layout.sidebarWidth).toBe(210)
    expect(layout.rightPanelCollapsed).toBe(true)
    expect(layout.rightPanelTab).toBe('settings')
  })

  it('selecting a tab expands a collapsed right panel', () => {
    const layout = new LayoutService()
    layout.setRightPanelCollapsed(true)
    layout.setRightPanelTab('toc')
    expect(layout.rightPanelCollapsed).toBe(false)
    expect(layout.rightPanelTab).toBe('toc')
  })

  it('toggleSidebar flips and persists', () => {
    const layout = new LayoutService()
    layout.toggleSidebar()
    expect(layout.sidebarCollapsed).toBe(true)
    expect(readLayoutState(localStorage).sidebarCollapsed).toBe(true)
    layout.toggleSidebar()
    expect(layout.sidebarCollapsed).toBe(false)
  })
})
