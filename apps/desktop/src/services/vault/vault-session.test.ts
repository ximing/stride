import { register, resolve } from '@rabjs/react'
import { createNote, plainText, serializeNote, type TipTapNode } from '@stride/core/note'
import { MemoryFileSystem } from '@stride/platform'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { notePath, readNoteFile } from '../../../../../packages/core/src/vault'
import { chatVaultHost } from '../chat/chat-vault-host'
import { NoteListService } from '../notes/note-list.service'
import { TABS_STORAGE_KEY, readVaultTabs } from '../notes/tabs'
import { TabsService } from '../notes/tabs.service'
import { applyNoteIdChanges } from './note-identity'
import { VaultService } from './vault.service'
import { upsertIndexed } from './vault-search-session'
import * as searchSession from './vault-search-session'

function useMemoryFixture() {
  window.history.replaceState(null, '', '/?fixture=memory')
}

function body(text: string): TipTapNode {
  return { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] }
}

function serialized(title: string, text: string): string {
  return serializeNote({ id: 'ignored', title, type: 'note', properties: {}, doc: body(text) })
}

async function openMemory(): Promise<VaultService> {
  useMemoryFixture()
  vi.stubGlobal('showDirectoryPicker', vi.fn())
  register(VaultService)
  const vault = resolve(VaultService)
  vault.cancelPending()
  await vault.openFromDraft()
  return vault
}

describe('vault session generation', () => {
  afterEach(() => {
    window.history.replaceState(null, '', '/')
    localStorage.removeItem(TABS_STORAGE_KEY)
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    try {
      resolve(VaultService).cancelPending()
    } catch {
      // not registered
    }
  })

  it('flushes a pending note before a tool writes a different note', async () => {
    const vault = await openMemory()
    await vault.createNote()
    const idA = vault.activeId
    vault.updateDoc(body('seed-a'))
    await vault.flush()
    await vault.createNote()
    const idB = vault.activeId
    vault.updateDoc(body('seed-b'))
    await vault.flush()
    vault.activeId = idA
    vault.updateDoc(body('user-alpha-pending'))
    expect(vault.pendingId).toBe(idA)

    await chatVaultHost(vault).writeSerialized(idB, serialized('Note B', 'tool-beta-word'))

    const savedA = await readNoteFile(vault.fs!, notePath(idA), idA)
    const savedB = await readNoteFile(vault.fs!, notePath(idB), idB)
    expect(plainText(savedA.doc)).toContain('user-alpha-pending')
    expect(plainText(savedB.doc)).toContain('tool-beta-word')
    expect(plainText(vault.notes.find((note) => note.id === idB)!.doc)).toContain('tool-beta-word')
    vault.searchQuery = 'tool-beta-word'
    await vault.runSearch()
    expect(vault.error).toBe('')
    expect(vault.searchHits.some((hit) => hit.id === idB)).toBe(true)
  })

  it('does not let an in-flight flush overwrite a tool write of the same note', async () => {
    const vault = await openMemory()
    await vault.createNote()
    const id = vault.activeId
    vault.updateDoc(body('seed'))
    await vault.flush()
    const fs = vault.fs!
    const original = fs.writeText.bind(fs)
    let release: (() => void) | null = null
    const entered = new Promise<void>((resolveEntered) => {
      fs.writeText = async (path, data) => {
        if (release === null && data.includes('user-old')) {
          resolveEntered()
          await new Promise<void>((resolveRelease) => {
            release = resolveRelease
          })
        }
        return original(path, data)
      }
    })
    vault.updateDoc(body('user-old'))
    const flushing = vault.flush()
    await entered
    const tool = chatVaultHost(vault).writeSerialized(id, serialized('Noted', 'tool-new'))
    release?.()
    const flushResult = await flushing.then(() => 'flushed', (error: unknown) => error)
    const toolResult = await tool.then(() => 'wrote', (error: unknown) => error)
    const saved = await readNoteFile(fs, notePath(id), id)
    const onDisk = plainText(saved.doc)
    if (toolResult === 'wrote') {
      expect(onDisk).toContain('tool-new')
      expect(onDisk).not.toContain('user-old')
    } else {
      expect(String(toolResult)).toMatch(/retry|session/i)
      expect(onDisk).not.toContain('user-old')
    }
    expect(flushResult === 'flushed' && toolResult === 'wrote' && onDisk.includes('user-old')).toBe(false)
  })

  it('does not upsert into the next rebuilder after the session changes', async () => {
    const vault = await openMemory()
    await vault.createNote()
    const note = vault.active!
    let release: (() => void) | undefined
    const entered = new Promise<void>((resolveEntered) => {
      const embed = vault.currentEmbedding.bind(vault)
      vault.currentEmbedding = async () => {
        if (!release) {
          resolveEntered()
          await new Promise<void>((resolveRelease) => {
            release = resolveRelease
          })
        }
        return embed()
      }
    })
    const pending = upsertIndexed(vault, { ...note, doc: body('late-word') })
    await entered
    const nextWrites: string[] = []
    vault.session += 1
    vault.rebuildEpoch += 1
    vault.rebuilder = {
      begin() {},
      cancel() {},
      upsert() {
        nextWrites.push('next')
        return Promise.resolve()
      },
      remove() {
        return Promise.resolve()
      },
      rebuild() {
        return Promise.resolve({ aborted: false })
      },
    }
    release?.()
    await pending
    expect(nextWrites).toEqual([])
  })

  it('keeps the old index searchable when opening the next index fails', async () => {
    const vault = await openMemory()
    await vault.createNote()
    const id = vault.activeId
    vault.updateDoc(body('keep-searchable'))
    await vault.flush()
    vault.searchQuery = 'keep-searchable'
    await vault.runSearch()
    expect(vault.searchHits.some((hit) => hit.id === id)).toBe(true)
    const index = vault.index
    const spy = vi.spyOn(searchSession, 'openSearchSession').mockRejectedValueOnce(new Error('open failed'))
    await expect(vault.reopenForSettings()).rejects.toThrow(/open failed/)
    expect(spy).toHaveBeenCalled()
    expect(vault.phase).toBe('ready')
    expect(vault.index).toBe(index)
    vault.searchQuery = 'keep-searchable'
    await vault.runSearch()
    expect(vault.error).toBe('')
    expect(vault.searchHits.some((hit) => hit.id === id)).toBe(true)
    spy.mockRestore()
    await vault.reopenForSettings()
    expect(vault.phase).toBe('ready')
    expect(vault.index).not.toBeNull()
    expect(vault.index).not.toBe(index)
    await vault.rebuildDone
    vault.searchQuery = 'keep-searchable'
    await vault.runSearch()
    expect(vault.error).toBe('')
    expect(vault.searchHits.some((hit) => hit.id === id)).toBe(true)
  })

  it('does not store the next vault note id in the previous stride:tabs', async () => {
    useMemoryFixture()
    vi.stubGlobal('showDirectoryPicker', vi.fn())
    register(VaultService)
    register(TabsService)
    const vault = resolve(VaultService)
    vault.cancelPending()
    await vault.openFromDraft()
    await vault.createNote()
    const previousId = vault.activeId
    const tabs = resolve(TabsService)
    tabs.openNote(previousId)
    await new Promise((resolveFlush) => setTimeout(resolveFlush, 0))
    const previousVault = vault.activeVaultId
    expect(readVaultTabs(localStorage, previousVault)?.tabs).toContain(previousId)

    const other = new MemoryFileSystem('other-vault')
    const fresh = createNote('fresh-note', 'Fresh')
    fresh.doc = body('fresh-body')
    await other.writeText('fresh-note.stride.json', serializeNote(fresh))
    await vault.openClonedVault(other)
    await new Promise((resolveFlush) => setTimeout(resolveFlush, 0))

    expect(vault.activeVaultId).not.toBe(previousVault)
    const stored = readVaultTabs(localStorage, previousVault)
    expect(stored?.tabs ?? []).not.toContain('fresh-note')
    expect(stored?.active ?? '').not.toBe('fresh-note')
  })

  it('remaps tabs, list selection, and search hits from one id map', async () => {
    const vault = await openMemory()
    register(TabsService)
    register(NoteListService)
    await vault.createNote()
    const first = vault.activeId
    await vault.createNote()
    const second = vault.activeId
    const tabs = resolve(TabsService)
    const list = resolve(NoteListService)
    tabs.openNote(first)
    vault.activeId = second
    list.selectedIds = [first, second]
    list.anchorId = first
    vault.searchHits = [{ id: first, score: 4 }, { id: second, score: 1 }]

    await applyNoteIdChanges(vault, [{ fromId: first, toId: 'moved-note' }])

    expect(vault.notes.some((note) => note.id === 'moved-note')).toBe(true)
    expect(vault.searchHits.map((hit) => hit.id)).toEqual(['moved-note', second])
    expect(list.selectedIds).toEqual(['moved-note', second])
    expect(list.anchorId).toBe('moved-note')
    expect(tabs.tabs.some((tab) => tab.noteId === 'moved-note')).toBe(true)
    expect(tabs.tabs.some((tab) => tab.noteId === first)).toBe(false)
  })
})
