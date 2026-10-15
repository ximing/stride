// Pure layout-state logic: shape, defaults, clamping, and localStorage
// (de)serialization. No rabjs or DOM dependencies so it stays unit-testable.

export type RightPanelTab = 'properties' | 'toc' | 'git' | 'chat' | 'settings'

export interface LayoutState {
  sidebarWidth: number
  noteListWidth: number
  rightPanelWidth: number
  sidebarCollapsed: boolean
  rightPanelCollapsed: boolean
  rightPanelTab: RightPanelTab
}

export const LAYOUT_STORAGE_KEY = 'stride:layout'

export const COLUMN_LIMITS = {
  sidebar: { min: 180, max: 360 },
  noteList: { min: 200, max: 440 },
  rightPanel: { min: 260, max: 560 },
} as const

export type ResizableColumn = keyof typeof COLUMN_LIMITS

export const RIGHT_PANEL_TABS: readonly RightPanelTab[] = ['properties', 'toc', 'git', 'chat', 'settings']

export const DEFAULT_LAYOUT_STATE: LayoutState = {
  sidebarWidth: 232,
  noteListWidth: 264,
  rightPanelWidth: 320,
  sidebarCollapsed: false,
  rightPanelCollapsed: false,
  rightPanelTab: 'properties',
}

export function clampColumnWidth(column: ResizableColumn, width: number): number {
  const { min, max } = COLUMN_LIMITS[column]
  if (!Number.isFinite(width)) return DEFAULT_LAYOUT_STATE[`${column}Width`]
  return Math.min(max, Math.max(min, Math.round(width)))
}

function isRightPanelTab(value: unknown): value is RightPanelTab {
  return typeof value === 'string' && (RIGHT_PANEL_TABS as readonly string[]).includes(value)
}

function widthOr(column: ResizableColumn, value: unknown): number {
  return typeof value === 'number' ? clampColumnWidth(column, value) : DEFAULT_LAYOUT_STATE[`${column}Width`]
}

/** Merge arbitrary stored JSON onto the defaults. Unknown/garbage fields fall back. */
export function sanitizeLayoutState(value: unknown): LayoutState {
  if (!value || typeof value !== 'object') return { ...DEFAULT_LAYOUT_STATE }
  const raw = value as Record<string, unknown>
  return {
    sidebarWidth: widthOr('sidebar', raw.sidebarWidth),
    noteListWidth: widthOr('noteList', raw.noteListWidth),
    rightPanelWidth: widthOr('rightPanel', raw.rightPanelWidth),
    sidebarCollapsed: raw.sidebarCollapsed === true,
    rightPanelCollapsed: raw.rightPanelCollapsed === true,
    rightPanelTab: isRightPanelTab(raw.rightPanelTab) ? raw.rightPanelTab : DEFAULT_LAYOUT_STATE.rightPanelTab,
  }
}

/** Minimal storage contract so tests can pass a fake; localStorage satisfies it. */
export interface LayoutStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export function readLayoutState(storage: LayoutStorage | null): LayoutState {
  if (!storage) return { ...DEFAULT_LAYOUT_STATE }
  try {
    const raw = storage.getItem(LAYOUT_STORAGE_KEY)
    if (!raw) return { ...DEFAULT_LAYOUT_STATE }
    return sanitizeLayoutState(JSON.parse(raw))
  } catch {
    return { ...DEFAULT_LAYOUT_STATE }
  }
}

export function writeLayoutState(storage: LayoutStorage | null, state: LayoutState): void {
  if (!storage) return
  try {
    storage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(sanitizeLayoutState(state)))
  } catch {
    // Quota or privacy-mode failures must never break layout interactions.
  }
}
