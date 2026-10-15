import { has, observe, register, Service, untracked } from '@rabjs/react'
import {
  closeTab,
  createTab,
  historyBack,
  historyForward,
  openOrFocus,
  pruneTabs,
  pushHistory,
  remapNoteId,
  readVaultTabs,
  writeVaultTabs,
  type TabState,
  type TabsStorage,
} from './tabs'
import { VaultService } from './vault.service'

let tabSeq = 0

function nextTabId(): string {
  tabSeq += 1
  return `tab-${tabSeq}`
}

function tabsStorage(): TabsStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

/**
 * Owns the editor tab strip and each tab's back/forward history.
 *
 * Design (see services/tabs.ts for the pure model):
 * - Every user-facing navigation funnels through `openNote` (open-or-focus a
 *   tab) or `followLink` (navigate inside the active tab, pushing history).
 * - `vault.select` stays the single selection primitive; TabsService calls it
 *   after updating its own state, and a reaction on `vault.activeId` converges
 *   tabs whenever vault internals select a note directly (createNote, inbox
 *   advance, autogit adopt, …). Convergence runs in a microtask so it only ever
 *   sees settled state, never mid-transaction transients (e.g. the notes array
 *   losing an id a tick before `remapNoteId` rewrites it during a rename).
 * - `onVaultOpened` (called by VaultService at the end of openBackendBody, once
 *   `activeVaultId` is final) restores the per-vault tab scene. Reactions that
 *   fire while a different vault is mid-open are ignored, so a vault switch can
 *   never pollute the previous vault's persisted tabs.
 * - Reference comparisons are always by raw id strings, never by object
 *   identity — values read back from `this.`/`vault.` may be reactive proxies.
 */
export class TabsService extends Service {
  tabs: TabState[] = []
  activeTabId = ''
  /** Vault the current scene belongs to; '' before the first open. */
  vaultKey = ''

  private scheduled = false

  constructor() {
    super()
    observe(() => {
      if (!has(VaultService)) return
      const vault = this.resolve(VaultService)
      // Track exactly these; all work happens untracked in the deferred syncNow.
      // scheduleSync reads/writes this.scheduled — without untracked() that read
      // becomes a dependency of this reaction and the microtask ping-pongs forever.
      void vault.phase
      void vault.activeVaultId
      void vault.activeId
      untracked(() => this.scheduleSync())
    })
  }

  private get vault(): VaultService | null {
    return has(VaultService) ? this.resolve(VaultService) : null
  }

  get activeTab(): TabState | null {
    return this.tabs.find((tab) => tab.id === this.activeTabId) ?? null
  }

  get canGoBack(): boolean {
    const tab = this.activeTab
    if (!tab) return false
    return tab.back.some((id) => this.isAlive(id))
  }

  get canGoForward(): boolean {
    const tab = this.activeTab
    if (!tab) return false
    return tab.forward.some((id) => this.isAlive(id))
  }

  /** Explicit open from a browsing surface: focus the existing tab or append one. */
  openNote(noteId: string) {
    const vault = this.vault
    if (!noteId || !vault) return
    // Unconditional select on purpose: vault.select no-ops on a same-id select,
    // and callers (and tests) rely on the call happening exactly like before tabs.
    if (this.activeTab?.noteId === noteId) {
      vault.select(noteId)
      return
    }
    const result = openOrFocus(this.tabs, noteId, nextTabId)
    this.tabs = result.tabs
    if (result.tab.id !== this.activeTabId) this.activeTabId = result.tab.id
    this.persist()
    vault.select(noteId)
  }

  /** Wikilink-style jump: navigate inside the active tab and record history. */
  followLink(noteId: string) {
    const vault = this.vault
    if (!noteId || !vault) return
    const active = this.activeTab
    if (!active) {
      this.openNote(noteId)
      return
    }
    if (active.noteId === noteId) return
    const next = pushHistory(active, noteId)
    this.tabs = this.tabs.map((tab) => (tab.id === active.id ? next : tab))
    this.persist()
    vault.select(noteId)
  }

  activateTab(tabId: string) {
    const tab = this.tabs.find((item) => item.id === tabId)
    if (!tab || tab.id === this.activeTabId) return
    this.activeTabId = tab.id
    this.persist()
    const vault = this.vault
    if (vault) vault.select(tab.noteId)
  }

  closeTab(tabId: string) {
    const closing = this.tabs.find((tab) => tab.id === tabId)
    if (!closing) return
    const wasActive = tabId === this.activeTabId
    const result = closeTab(this.tabs, tabId, this.activeTabId)
    this.tabs = result.tabs
    this.activeTabId = result.activeTabId
    this.persist()
    if (!wasActive) return
    const vault = this.vault
    if (!vault) return
    vault.select(this.activeTab?.noteId ?? '')
  }

  closeActiveTab() {
    if (this.activeTabId) this.closeTab(this.activeTabId)
  }

  /** Mod+1..9: activate the Nth tab (1-based index in the strip). */
  selectTabAt(index: number) {
    const tab = this.tabs[index]
    if (tab) this.activateTab(tab.id)
  }

  goBack() {
    this.navigateHistory('back')
  }

  goForward() {
    this.navigateHistory('forward')
  }

  /** Rename/move hook from VaultService/FolderService: rewrite the id everywhere. */
  remapNoteId(fromId: string, toId: string) {
    if (!fromId || fromId === toId || this.tabs.length === 0) return
    this.tabs = remapNoteId(this.tabs, fromId, toId)
    this.persist()
  }

  /** VaultService calls this at the end of openBackendBody (activeVaultId final). */
  onVaultOpened() {
    const vault = this.vault
    if (!vault || vault.phase !== 'ready') return
    const vid = vault.activeVaultId
    if (!vid) return
    if (vid === this.vaultKey) {
      // Same vault reopened (e.g. re-picked folder): keep tabs, reconverge.
      this.converge(vault.activeId)
      return
    }
    this.vaultKey = vid
    if (this.restoreForVault(vid)) {
      const current = this.activeTab?.noteId ?? ''
      if (current !== vault.activeId) vault.select(current)
      return
    }
    this.converge(vault.activeId)
  }

  private navigateHistory(direction: 'back' | 'forward') {
    const vault = this.vault
    const tab = this.activeTab
    if (!vault || !tab) return
    const step = direction === 'back' ? historyBack : historyForward
    // Skip entries whose notes were deleted while sitting in history.
    let next = step(tab)
    let guard = 0
    while (next && !this.isAlive(next.noteId) && guard < 100) {
      next = step(next)
      guard += 1
    }
    if (!next) return
    this.tabs = this.tabs.map((item) => (item.id === tab.id ? next : item))
    this.persist()
    vault.select(next.noteId)
  }

  private isAlive(noteId: string): boolean {
    const vault = this.vault
    return vault !== null && vault.notes.some((note) => note.id === noteId)
  }

  private scheduleSync() {
    if (this.scheduled) return
    this.scheduled = true
    queueMicrotask(() => {
      this.scheduled = false
      this.syncNow()
    })
  }

  private syncNow() {
    const vault = this.vault
    if (!vault || vault.phase !== 'ready') return
    // A different vault mid-open owns activeId but not this scene; onVaultOpened
    // performs the handover once activeVaultId is final.
    const vid = vault.activeVaultId
    if (!vid || vid !== this.vaultKey) return
    this.converge(vault.activeId)
  }

  /** Align tabs with a vault-driven selection change. Never writes back to the vault. */
  private converge(activeId: string) {
    const aliveIds = new Set((this.vault?.notes ?? []).map((note) => note.id))
    const active = this.activeTab
    if (active && !aliveIds.has(active.noteId)) {
      // The active tab's note was deleted: close it and focus the neighbor.
      const result = closeTab(this.tabs, active.id, this.activeTabId)
      this.tabs = result.tabs
      this.activeTabId = result.activeTabId
      this.persist()
      const next = this.activeTab?.noteId ?? ''
      if (next) {
        const vault = this.vault
        if (vault && vault.activeId !== next) vault.select(next)
        return
      }
      // No neighbor left: fall through — the vault's own fallback selection
      // (deleteActiveNote picks the first visible note) opens a fresh tab.
    }
    const pruned = pruneTabs(this.tabs, (id) => aliveIds.has(id))
    if (pruned.length !== this.tabs.length) {
      const activeSurvives = pruned.some((tab) => tab.id === this.activeTabId)
      this.tabs = pruned
      if (!activeSurvives) this.activeTabId = pruned[0]?.id ?? ''
      this.persist()
    }
    if (!activeId) {
      if (this.activeTabId !== '') {
        this.activeTabId = ''
        this.persist()
      }
      return
    }
    // Mid-rename transients resolve via remapNoteId; an unknown id here is stale.
    if (!aliveIds.has(activeId)) return
    const current = this.activeTab
    if (current && current.noteId === activeId) return
    const existing = this.tabs.find((tab) => tab.noteId === activeId)
    if (existing) {
      if (existing.id !== this.activeTabId) {
        this.activeTabId = existing.id
        this.persist()
      }
      return
    }
    // Programmatic selection (createNote, inbox advance, adopt fallback, …):
    // continue the current tab's journey rather than spawning a tab.
    if (current) {
      const pushed = pushHistory(current, activeId)
      this.tabs = this.tabs.map((tab) => (tab.id === current.id ? pushed : tab))
    } else {
      this.tabs = [...this.tabs, createTab(activeId, nextTabId)]
      this.activeTabId = this.tabs[this.tabs.length - 1]!.id
    }
    this.persist()
  }

  /** Restore the persisted scene for a vault. Returns false when nothing usable. */
  private restoreForVault(vaultId: string): boolean {
    const alive = new Set((this.vault?.notes ?? []).map((note) => note.id))
    const stored = readVaultTabs(tabsStorage(), vaultId)
    // Tabs whose notes were deleted or renamed away since the last session drop out.
    const noteIds = stored ? stored.tabs.filter((id) => alive.has(id)) : []
    if (noteIds.length === 0) {
      if (this.tabs.length > 0 || this.activeTabId !== '') {
        this.tabs = []
        this.activeTabId = ''
      }
      return false
    }
    const activeNoteId = stored && stored.active && noteIds.includes(stored.active) ? stored.active : noteIds[0]!
    this.tabs = noteIds.map((id) => createTab(id, nextTabId()))
    this.activeTabId = this.tabs.find((tab) => tab.noteId === activeNoteId)?.id ?? this.tabs[0]!.id
    this.persist()
    return true
  }

  private persist() {
    if (!this.vaultKey) return
    writeVaultTabs(tabsStorage(), this.vaultKey, {
      tabs: this.tabs.map((tab) => tab.noteId),
      active: this.activeTab?.noteId ?? '',
    })
  }
}

// Tests mount tab-aware UI without main.tsx, so the global service must exist on import.
if (!has(TabsService)) register(TabsService)
