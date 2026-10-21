import { has, register, resolve } from '@rabjs/react'
import { createNote, noteForSave, type StrideNote } from '@stride/core/note'
import { afterEach, describe, expect, it } from 'vitest'
import { saveNote } from '../../../../../packages/core/src/vault'
import { CommandService } from '../commands/command.service'
import { shortcutToKeyEventInit } from '../commands/commands'
import { TabsService } from './tabs.service'
import { readVaultTabs, TABS_STORAGE_KEY } from './tabs'
import { VaultService } from '../vault/vault.service'

function sample(id: string, title: string): StrideNote {
  return createNote(id, title)
}

function useMemoryFixture() {
  window.history.replaceState(null, '', '/?fixture=memory')
}

/** Convergence runs in a microtask; a macrotask drains the whole chain. */
function flushTabs(): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, 0))
}

function pressShortcut(shortcut: string): boolean {
  const init = shortcutToKeyEventInit(shortcut)
  if (!init) throw new Error(`bad shortcut ${shortcut}`)
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  return resolve(CommandService).dispatchKeydown(event)
}

async function openVaultWithNotes(ids: string[]): Promise<{ vault: VaultService; tabs: TabsService }> {
  useMemoryFixture()
  if (!has(VaultService)) register(VaultService)
  const vault = resolve(VaultService)
  await vault.openFromDraft()
  const tabs = resolve(TabsService)
  // deleteActiveNote touches the filesystem, so fixture notes must exist on disk.
  const fs = vault.fs
  if (!fs) throw new Error('memory fixture did not open')
  const notes: StrideNote[] = []
  for (const id of ids) {
    notes.push(await saveNote(fs, noteForSave(sample(id, id.toUpperCase()))))
  }
  vault.notes = notes
  vault.activeId = ''
  await flushTabs()
  tabs.tabs = []
  tabs.activeTabId = ''
  return { vault, tabs }
}

describe('TabsService', () => {
  afterEach(() => {
    window.history.replaceState(null, '', '/')
    localStorage.removeItem(TABS_STORAGE_KEY)
    const tabs = resolve(TabsService)
    tabs.tabs = []
    tabs.activeTabId = ''
    tabs.vaultKey = ''
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
  })

  it('opens one tab per note and focuses an already-open tab', async () => {
    const { vault, tabs } = await openVaultWithNotes(['a', 'b', 'c'])
    tabs.openNote('a')
    tabs.openNote('b')
    expect(tabs.tabs.map((tab) => tab.noteId)).toEqual(['a', 'b'])
    expect(vault.activeId).toBe('b')
    tabs.openNote('a')
    expect(tabs.tabs.map((tab) => tab.noteId)).toEqual(['a', 'b'])
    expect(tabs.activeTab?.noteId).toBe('a')
    expect(vault.activeId).toBe('a')
    await flushTabs()
    expect(tabs.tabs.map((tab) => tab.noteId)).toEqual(['a', 'b'])
  })

  it('followLink navigates inside the tab and goBack/goForward walk its history', async () => {
    const { vault, tabs } = await openVaultWithNotes(['a', 'b', 'c'])
    tabs.openNote('a')
    tabs.followLink('b')
    tabs.followLink('c')
    expect(tabs.tabs.map((tab) => tab.noteId)).toEqual(['c'])
    expect(tabs.canGoBack).toBe(true)
    expect(tabs.canGoForward).toBe(false)
    tabs.goBack()
    expect(vault.activeId).toBe('b')
    tabs.goBack()
    expect(vault.activeId).toBe('a')
    expect(tabs.canGoBack).toBe(false)
    expect(tabs.canGoForward).toBe(true)
    tabs.goForward()
    expect(vault.activeId).toBe('b')
    // A fresh jump truncates the forward trail.
    tabs.followLink('c')
    tabs.goBack()
    tabs.followLink('a')
    expect(tabs.canGoForward).toBe(false)
    expect(tabs.activeTab?.back).toEqual(['a', 'b'])
  })

  it('keeps histories independent per tab', async () => {
    const { tabs } = await openVaultWithNotes(['a', 'b', 'c'])
    tabs.openNote('a')
    tabs.followLink('b')
    tabs.openNote('c')
    expect(tabs.tabs).toHaveLength(2)
    tabs.goBack()
    // The other tab is untouched; goBack on it has nowhere to go.
    const first = tabs.tabs[0]!
    expect(first.noteId).toBe('b')
    tabs.activateTab(first.id)
    tabs.goBack()
    expect(tabs.activeTab?.noteId).toBe('a')
    expect(tabs.tabs[1]?.noteId).toBe('c')
  })

  it('closing the active tab focuses the neighbor and closing the last clears the selection', async () => {
    const { vault, tabs } = await openVaultWithNotes(['a', 'b', 'c'])
    tabs.openNote('a')
    tabs.openNote('b')
    tabs.openNote('c')
    tabs.activateTab(tabs.tabs[0]!.id)
    tabs.closeActiveTab()
    expect(tabs.tabs.map((tab) => tab.noteId)).toEqual(['b', 'c'])
    expect(vault.activeId).toBe('b')
    tabs.closeActiveTab()
    expect(vault.activeId).toBe('c')
    tabs.closeActiveTab()
    expect(tabs.tabs).toEqual([])
    expect(vault.activeId).toBe('')
    await flushTabs()
    expect(vault.activeId).toBe('')
  })

  it('deleting the active note closes its tab and focuses the neighbor', async () => {
    const { vault, tabs } = await openVaultWithNotes(['a', 'b', 'c'])
    tabs.openNote('a')
    tabs.openNote('b')
    tabs.openNote('c')
    tabs.activateTab(tabs.tabs[1]!.id)
    await vault.deleteActiveNote()
    await flushTabs()
    expect(vault.notes.some((note) => note.id === 'b')).toBe(false)
    expect(tabs.tabs.map((tab) => tab.noteId)).toEqual(['a', 'c'])
    expect(tabs.activeTab?.noteId).toBe('c')
    expect(vault.activeId).toBe('c')
  })

  it('follows a heading rename instead of closing the tab', async () => {
    useMemoryFixture()
    if (!has(VaultService)) register(VaultService)
    const vault = resolve(VaultService)
    await vault.openFromDraft()
    const tabs = resolve(TabsService)
    await vault.createNote()
    await flushTabs()
    expect(tabs.activeTab?.noteId).toBe(vault.activeId)
    const before = vault.activeId
    vault.updateTitle('Renamed Note')
    await vault.commitHeadingRename()
    await flushTabs()
    expect(vault.error).toBe('')
    expect(vault.activeId).toBe('renamed-note')
    expect(tabs.activeTab?.noteId).toBe('renamed-note')
    expect(tabs.tabs).toHaveLength(1)
    expect(tabs.activeTab?.noteId).not.toBe(before)
  })

  it('persists the tab scene per vault and restores it, dropping dead notes', async () => {
    const { vault, tabs } = await openVaultWithNotes(['a', 'b', 'c'])
    tabs.openNote('a')
    tabs.openNote('b')
    const vid = vault.activeVaultId
    expect(vid).not.toBe('')
    expect(readVaultTabs(localStorage, vid)).toEqual({ tabs: ['a', 'b'], active: 'b' })

    // A stale entry for a deleted note is dropped on restore.
    localStorage.setItem(
      TABS_STORAGE_KEY,
      JSON.stringify({ version: 1, vaults: { [vid]: { tabs: ['a', 'ghost', 'b'], active: 'ghost' } } }),
    )

    // Simulate a reload: fresh service state, vault reopened with its default selection.
    tabs.tabs = []
    tabs.activeTabId = ''
    tabs.vaultKey = ''
    vault.activeId = 'a'
    await flushTabs()
    expect(tabs.tabs).toEqual([])
    tabs.onVaultOpened()
    expect(tabs.tabs.map((tab) => tab.noteId)).toEqual(['a', 'b'])
    // The persisted active was the dead "ghost"; fall back to the first tab.
    expect(tabs.activeTab?.noteId).toBe('a')
    expect(vault.activeId).toBe('a')
  })

  it('restores the persisted active tab over the vault default selection', async () => {
    const { vault, tabs } = await openVaultWithNotes(['a', 'b'])
    tabs.openNote('a')
    tabs.openNote('b')
    const vid = vault.activeVaultId
    expect(readVaultTabs(localStorage, vid)?.active).toBe('b')
    tabs.tabs = []
    tabs.activeTabId = ''
    tabs.vaultKey = ''
    vault.activeId = 'a'
    await flushTabs()
    tabs.onVaultOpened()
    expect(tabs.activeTab?.noteId).toBe('b')
    expect(vault.activeId).toBe('b')
  })

  it('dispatches Mod+1..9 and Mod+[/] through the manifest dispatcher', async () => {
    const { vault, tabs } = await openVaultWithNotes(['a', 'b', 'c'])
    tabs.openNote('a')
    tabs.openNote('b')
    tabs.followLink('c')
    expect(pressShortcut('Mod+1')).toBe(true)
    expect(vault.activeId).toBe('a')
    expect(pressShortcut('Mod+2')).toBe(true)
    expect(vault.activeId).toBe('c')
    expect(pressShortcut('Mod+9')).toBe(true)
    expect(vault.activeId).toBe('c')
    expect(pressShortcut('Mod+[')).toBe(true)
    expect(vault.activeId).toBe('b')
    expect(pressShortcut('Mod+]')).toBe(true)
    expect(vault.activeId).toBe('c')
    // Second tab has no more back history: the binding is disabled.
    tabs.goBack()
    expect(pressShortcut('Mod+[')).toBe(false)
  })

  it('closes the active tab via Mod+W in the browser but not on the desktop runtime', async () => {
    const { vault, tabs } = await openVaultWithNotes(['a', 'b'])
    tabs.openNote('a')
    tabs.openNote('b')
    expect(pressShortcut('Mod+W')).toBe(true)
    expect(tabs.tabs.map((tab) => tab.noteId)).toEqual(['a'])
    expect(vault.activeId).toBe('a')

    // Under Tauri the OS menu owns Mod+W (window close); the binding is inert.
    ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
    expect(pressShortcut('Mod+W')).toBe(false)
    expect(tabs.tabs.map((tab) => tab.noteId)).toEqual(['a'])
    expect(vault.activeId).toBe('a')
  })

  it('converges when vault internals select a note directly (createNote gets a tab)', async () => {
    useMemoryFixture()
    if (!has(VaultService)) register(VaultService)
    const vault = resolve(VaultService)
    await vault.openFromDraft()
    const tabs = resolve(TabsService)
    // The shared memory fixture may still hold notes from earlier tests.
    vault.notes = []
    vault.activeId = ''
    await flushTabs()
    expect(tabs.tabs).toEqual([])
    await vault.createNote()
    await flushTabs()
    const created = vault.activeId
    expect(created).not.toBe('')
    expect(tabs.activeTab?.noteId).toBe(created)
    await vault.createNote()
    await flushTabs()
    // Programmatic selection continues the current tab's journey (back works).
    expect(tabs.tabs).toHaveLength(1)
    expect(tabs.activeTab?.back).toEqual([created])
    tabs.goBack()
    expect(vault.activeId).toBe(created)
  })
})
