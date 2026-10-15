// Pure tab-strip and per-tab navigation-history logic plus the localStorage
// (de)serialization for `stride:tabs`. No rabjs or DOM dependencies so it stays
// unit-testable. TabsService owns the reactive shell around these primitives.
//
// Model: one tab per open note for explicit opens (list / quick open / search /
// backlinks open-or-focus a tab); following a wikilink navigates inside the
// active tab and pushes onto that tab's history. Only tab order, each tab's
// current note id, and the active tab are persisted — history is session-only.

export interface TabState {
  /** Stable identity for React keys; regenerated on restore. */
  id: string
  /** The note this tab currently shows (top of its history). */
  noteId: string
  /** Older entries, nearest-last: back = [...older, previous]. */
  back: string[]
  /** Newer entries after a goBack, nearest-first: forward = [next, ...newer]. */
  forward: string[]
}

export function createTab(noteId: string, id: string): TabState {
  return { id, noteId, back: [], forward: [] }
}

/** Navigate the tab to another note, truncating the forward trail. Same-note is a no-op. */
export function pushHistory(tab: TabState, noteId: string): TabState {
  if (!noteId || noteId === tab.noteId) return tab
  return { ...tab, back: [...tab.back, tab.noteId], noteId, forward: [] }
}

/** One step back. Returns null when there is nowhere to go. */
export function historyBack(tab: TabState): TabState | null {
  const previous = tab.back[tab.back.length - 1]
  if (previous === undefined) return null
  return { ...tab, back: tab.back.slice(0, -1), noteId: previous, forward: [tab.noteId, ...tab.forward] }
}

/** One step forward. Returns null when there is nowhere to go. */
export function historyForward(tab: TabState): TabState | null {
  const next = tab.forward[0]
  if (next === undefined) return null
  return { ...tab, back: [...tab.back, tab.noteId], noteId: next, forward: tab.forward.slice(1) }
}

export interface OpenResult {
  tabs: TabState[]
  tab: TabState
  created: boolean
}

/** Focus the tab already showing `noteId`, else append a fresh tab for it. */
export function openOrFocus(tabs: readonly TabState[], noteId: string, makeId: () => string): OpenResult {
  const existing = tabs.find((tab) => tab.noteId === noteId)
  if (existing) return { tabs: [...tabs], tab: existing, created: false }
  const tab = createTab(noteId, makeId())
  return { tabs: [...tabs, tab], tab, created: true }
}

export interface CloseResult {
  tabs: TabState[]
  /** The tab to activate after the close ('' when none remain). Neighbor rule:
   *  closing the active tab focuses the tab that slides into its slot (the right
   *  neighbor), falling back to the new last tab. Closing a background tab keeps
   *  the current active tab. */
  activeTabId: string
}

export function closeTab(tabs: readonly TabState[], tabId: string, activeTabId: string): CloseResult {
  const index = tabs.findIndex((tab) => tab.id === tabId)
  if (index === -1) return { tabs: [...tabs], activeTabId }
  const next = tabs.filter((tab) => tab.id !== tabId)
  if (tabId !== activeTabId) {
    return { tabs: next, activeTabId: next.some((tab) => tab.id === activeTabId) ? activeTabId : (next[0]?.id ?? '') }
  }
  const neighbor = next[index] ?? next[index - 1]
  return { tabs: next, activeTabId: neighbor?.id ?? '' }
}

/** Rewrite every occurrence of a note id (current + history) after a rename/move. */
export function remapNoteId(tabs: readonly TabState[], fromId: string, toId: string): TabState[] {
  if (!fromId || fromId === toId) return [...tabs]
  const remap = (id: string) => (id === fromId ? toId : id)
  return tabs.map((tab) => {
    if (tab.noteId !== fromId && !tab.back.includes(fromId) && !tab.forward.includes(fromId)) return tab
    return {
      ...tab,
      noteId: remap(tab.noteId),
      back: tab.back.map(remap),
      forward: tab.forward.map(remap),
    }
  })
}

/** Drop tabs whose current note is gone and scrub dead ids from surviving histories. */
export function pruneTabs(tabs: readonly TabState[], isAlive: (noteId: string) => boolean): TabState[] {
  return tabs
    .filter((tab) => isAlive(tab.noteId))
    .map((tab) => {
      const back = tab.back.filter(isAlive)
      const forward = tab.forward.filter(isAlive)
      if (back.length === tab.back.length && forward.length === tab.forward.length) return tab
      return { ...tab, back, forward }
    })
}

// ---------- persistence ----------

export const TABS_STORAGE_KEY = 'stride:tabs'
export const TABS_FILE_VERSION = 1

/** Per-vault persisted scene: ordered tab note ids plus the active tab's note id. */
export interface PersistedVaultTabs {
  tabs: string[]
  active: string
}

interface TabsFile {
  version: number
  vaults: Record<string, PersistedVaultTabs>
}

/** Minimal storage contract so tests can pass a fake; localStorage satisfies it. */
export interface TabsStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

function isNoteIdList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string' && item !== '')
}

/** Validate arbitrary stored JSON into a per-vault scene. Garbage yields null. */
export function sanitizeVaultTabs(value: unknown): PersistedVaultTabs | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  if (!isNoteIdList(raw.tabs)) return null
  const tabs = [...new Set(raw.tabs)]
  const active = typeof raw.active === 'string' ? raw.active : ''
  return { tabs, active }
}

function readTabsFile(storage: TabsStorage | null): TabsFile {
  const empty: TabsFile = { version: TABS_FILE_VERSION, vaults: {} }
  if (!storage) return empty
  try {
    const raw = storage.getItem(TABS_STORAGE_KEY)
    if (!raw) return empty
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return empty
    const file = parsed as Record<string, unknown>
    if (file.version !== TABS_FILE_VERSION || !file.vaults || typeof file.vaults !== 'object' || Array.isArray(file.vaults)) {
      return empty
    }
    const vaults: Record<string, PersistedVaultTabs> = {}
    for (const [vaultId, scene] of Object.entries(file.vaults as Record<string, unknown>)) {
      const sanitized = sanitizeVaultTabs(scene)
      if (sanitized) vaults[vaultId] = sanitized
    }
    return { version: TABS_FILE_VERSION, vaults }
  } catch {
    return empty
  }
}

/** The persisted tab scene for one vault, or null when absent/garbage. */
export function readVaultTabs(storage: TabsStorage | null, vaultId: string): PersistedVaultTabs | null {
  if (!vaultId) return null
  return readTabsFile(storage).vaults[vaultId] ?? null
}

/** Merge one vault's scene into the tabs file. Never throws on quota/privacy failures. */
export function writeVaultTabs(storage: TabsStorage | null, vaultId: string, scene: PersistedVaultTabs): void {
  if (!storage || !vaultId) return
  const sanitized = sanitizeVaultTabs(scene)
  if (!sanitized) return
  try {
    const file = readTabsFile(storage)
    file.vaults[vaultId] = sanitized
    storage.setItem(TABS_STORAGE_KEY, JSON.stringify(file))
  } catch {
    // Quota or privacy-mode failures must never break tab interactions.
  }
}
