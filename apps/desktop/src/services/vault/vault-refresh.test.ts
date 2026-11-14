import { raw, register, resolve } from '@rabjs/react'
import { createNote, plainText, serializeNote, type StrideNote, type TipTapNode } from '@stride/core/note'
import { notePath, readNoteFile } from '@stride/core'
import { MemoryFileSystem, type FileSystemBackend } from '@stride/platform'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FolderService } from './folder.service'
import { NoteListService } from '../notes/note-list.service'
import { TabsService } from '../notes/tabs.service'
import {
  keepDraftConflict,
  loadDiskConflict,
  mergeRefreshedNotes,
  refreshVaultPaths,
  rememberDiskConflict,
} from './vault-refresh'
import { classifyWatchedPaths, ignoredWatchPath, shouldAttachDiskWatch } from './vault-watch'
import { VaultService } from './vault.service'

function useMemoryFixture() {
  window.history.replaceState(null, '', '/?fixture=memory')
}

function body(text: string): TipTapNode {
  return { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] }
}

function baseline() {
  return { dirty: new Set<string>(), generation: 0 }
}

async function openMemory(): Promise<VaultService> {
  useMemoryFixture()
  vi.stubGlobal('showDirectoryPicker', vi.fn())
  register(VaultService)
  register(FolderService)
  register(NoteListService)
  register(TabsService)
  const vault = resolve(VaultService)
  vault.cancelPending()
  await vault.openFromDraft()
  return vault
}

async function opened(): Promise<VaultService> {
  const vault = await openMemory()
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 0))
  return vault
}

async function fileMtime(vault: VaultService, id: string): Promise<number> {
  const info = await vault.fs!.stat(notePath(id))
  if (!info || info.kind !== 'file') throw new Error(`missing ${id}`)
  return info.mtimeMs
}

async function storeMtime(vault: VaultService, id: string): Promise<number> {
  const mtime = await fileMtime(vault, id)
  vault.noteMtimes = { ...vault.noteMtimes, [id]: mtime }
  return mtime
}

describe('mergeRefreshedNotes', () => {
  const previous = createNote('m', 'Kept')
  const disk = createNote('m', 'Disk')

  it('keeps the in-memory object when the serialized note matches', () => {
    const same = createNote('m', 'Kept')
    const merged = mergeRefreshedNotes({
      previous: [previous],
      diskIds: new Set(['m']),
      diskNotes: new Map([['m', same]]),
      unchangedIds: new Set(),
      dirty: new Set(),
      beforeIds: new Set(['m']),
    })
    expect(merged).toEqual([previous])
    expect(merged[0]).toBe(previous)
  })

  it('keeps a dirty note and drops an external delete of a clean one', () => {
    const dirty = createNote('a', 'Local')
    const gone = createNote('b', 'Gone')
    const merged = mergeRefreshedNotes({
      previous: [dirty, gone],
      diskIds: new Set(['a']),
      diskNotes: new Map([['a', createNote('a', 'External')]]),
      unchangedIds: new Set(),
      dirty: new Set(['a']),
      beforeIds: new Set(['a', 'b']),
    })
    expect(merged).toEqual([dirty])
    expect(merged[0]).toBe(dirty)
  })

  it('keeps a note created during the scan and does not resurrect a deleted one', () => {
    const created = createNote('new', 'New')
    const resurrect = createNote('old', 'Old')
    const merged = mergeRefreshedNotes({
      previous: [created],
      diskIds: new Set(['old', 'external']),
      diskNotes: new Map<string, StrideNote>([
        ['old', resurrect],
        ['external', createNote('external', 'External')],
      ]),
      unchangedIds: new Set(),
      dirty: new Set(),
      beforeIds: new Set(['old']),
    })
    expect(merged.map((note) => note.id)).toEqual(['new', 'external'])
    expect(merged[0]).toBe(created)
  })

  it('appends external creates in id order after the previous notes', () => {
    const merged = mergeRefreshedNotes({
      previous: [previous],
      diskIds: new Set(['m', 'b', 'a']),
      diskNotes: new Map<string, StrideNote>([
        ['m', createNote('m', 'Kept')],
        ['b', createNote('b', 'B')],
        ['a', createNote('a', 'A')],
      ]),
      unchangedIds: new Set(['m']),
      dirty: new Set(),
      beforeIds: new Set(['m']),
    })
    expect(merged.map((note) => note.id)).toEqual(['m', 'a', 'b'])
    expect(merged[0]).toBe(previous)
  })

  it('keeps the previous note when the file is unreadable', () => {
    const merged = mergeRefreshedNotes({
      previous: [previous],
      diskIds: new Set(['m']),
      diskNotes: new Map(),
      unchangedIds: new Set(),
      dirty: new Set(),
      beforeIds: new Set(['m']),
    })
    expect(merged[0]).toBe(previous)
  })
})

describe('vault disk refresh', () => {
  afterEach(() => {
    window.history.replaceState(null, '', '/')
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    try {
      const vault = resolve(VaultService)
      vault.unwatchDisk()
      vault.cancelPending()
    } catch {
      // not registered
    }
  })

  it('does not attach an OS watch to the memory fixture', async () => {
    const watch = vi.spyOn(MemoryFileSystem.prototype, 'watch')
    const vault = await openMemory()
    // Saved-view reload can also watch when that service is already registered.
    // The vault binder itself must still skip the memory filesystem.
    expect(raw(vault.fs!) instanceof MemoryFileSystem).toBe(true)
    expect(shouldAttachDiskWatch(vault.fs!, false)).toBe(false)
    expect(shouldAttachDiskWatch(vault.fs!, true)).toBe(false)
    watch.mockClear()
    vault.unwatchDisk()
    vault.watchDisk()
    expect(watch).not.toHaveBeenCalled()
    expect(shouldAttachDiskWatch(vault.fs!, false)).toBe(false)
    expect(shouldAttachDiskWatch(vault.fs!, true)).toBe(false)
    const desktop = { capabilities: { watch: true } } as FileSystemBackend
    expect(shouldAttachDiskWatch(desktop, false)).toBe(true)
    expect(shouldAttachDiskWatch(desktop, true)).toBe(false)
  })

  it('classifies directories and attachments before refreshing', async () => {
    const fs = new MemoryFileSystem('memory-vault')
    await fs.writeText('pic.png', 'x')
    await fs.mkdir('box')
    expect(ignoredWatchPath('')).toBe(false)
    expect(ignoredWatchPath('.stride/views/a.json')).toBe(true)
    expect(ignoredWatchPath('node_modules/pkg/index.js')).toBe(true)
    expect(await classifyWatchedPaths(fs, ['pic.png'])).toEqual([])
    expect(await classifyWatchedPaths(fs, ['box'])).toBe('full')
    expect(await classifyWatchedPaths(fs, ['missing.png'])).toBe('full')
    expect(await classifyWatchedPaths(fs, ['.git/config', 'notes/a.stride.json'])).toEqual(['notes/a.stride.json'])
  })

  it('picks up a new folder and note, then keeps object identity', async () => {
    const vault = await openMemory()
    await vault.createNote()
    const existing = vault.notes[0]!
    const epoch = vault.docEpoch
    const fs = vault.fs!
    await fs.mkdir('inbox-box')
    await fs.writeText(notePath('inbox-box/fresh'), serializeNote(createNote('inbox-box/fresh', 'Fresh from disk')))

    await vault.refreshFromDisk()
    expect(vault.error).toBe('')
    expect(resolve(FolderService).folders).toContain('inbox-box')
    expect(vault.notes.map((note) => note.id)).toContain('inbox-box/fresh')
    expect(vault.notes.find((note) => note.id === existing.id)).toBe(existing)
    expect(vault.docEpoch).toBe(epoch)

    const fresh = vault.notes.find((note) => note.id === 'inbox-box/fresh')
    await vault.refreshFromDisk()
    expect(vault.notes.find((note) => note.id === 'inbox-box/fresh')).toBe(fresh)
    expect(vault.notes.find((note) => note.id === existing.id)).toBe(existing)
    expect(vault.docEpoch).toBe(epoch)
  })

  it('drops a deleted note and moves the active note', async () => {
    const vault = await openMemory()
    await vault.createNote()
    const kept = vault.activeId
    await vault.createNote()
    const removed = vault.activeId
    expect(removed).not.toBe(kept)
    resolve(NoteListService).selectedIds = [removed, kept]
    resolve(NoteListService).anchorId = removed
    await vault.fs!.remove(notePath(removed))

    await vault.refreshFromDisk()
    expect(vault.notes.some((note) => note.id === removed)).toBe(false)
    expect(vault.activeId).toBe(kept)
    expect(resolve(NoteListService).selectedIds).toEqual([kept])
    expect(resolve(NoteListService).anchorId).toBe(kept)
  })

  it('bumps docEpoch when the active note body changes on disk', async () => {
    const vault = await openMemory()
    await vault.createNote()
    const epoch = vault.docEpoch
    const id = vault.activeId
    const note = vault.active!
    await vault.fs!.writeText(notePath(id), serializeNote({ ...note, doc: body('from disk') }))

    await vault.refreshFromDisk()
    expect(vault.docEpoch).toBe(epoch + 1)
    expect(plainText(vault.active!.doc)).toContain('from disk')
  })

  it('flushes a pending edit so it wins over an external write', async () => {
    const vault = await openMemory()
    await vault.createNote()
    const id = vault.activeId
    const epoch = vault.docEpoch
    vault.updateDoc(body('local edit'))
    expect(vault.pendingId).toBe(id)
    await vault.fs!.writeText(notePath(id), serializeNote(createNote(id, 'External')))

    await vault.refreshFromDisk()
    const saved = await readNoteFile(vault.fs!, notePath(id), id)
    expect(plainText(saved.doc)).toContain('local edit')
    expect(plainText(vault.active!.doc)).toContain('local edit')
    expect(plainText(vault.active!.doc)).not.toContain('External')
    expect(vault.docEpoch).toBe(epoch)
  })

  it('reloads folders when a path refresh sees a new parent', async () => {
    const vault = await openMemory()
    await vault.createNote()
    const kept = vault.notes[0]!
    const fs = vault.fs!
    await fs.writeText(notePath('inbox-box/fresh'), serializeNote(createNote('inbox-box/fresh', 'Fresh from disk')))
    await refreshVaultPaths(vault, [notePath('inbox-box/fresh')], baseline)
    expect(resolve(FolderService).folders).toContain('inbox-box')
    expect(vault.notes.some((note) => note.id === 'inbox-box/fresh')).toBe(true)
    expect(vault.notes.find((note) => note.id === kept.id)).toBe(kept)
  })

  it('leaves an unreadable note in place', async () => {
    const vault = await openMemory()
    await vault.createNote()
    const note = vault.notes[0]!
    await vault.fs!.writeText(notePath(note.id), 'not json')
    await vault.refreshFromDisk()
    expect(vault.notes.find((item) => item.id === note.id)).toBe(note)
    expect(vault.error).toBe('')
  })

  it('keeps an unsaved draft when the file mtime changes and does not bump docEpoch', async () => {
    const vault = await opened()
    await vault.createNote()
    const id = vault.activeId
    await storeMtime(vault, id)
    const epoch = vault.docEpoch
    const external = serializeNote(createNote(id, 'External'))
    await vault.fs!.writeText(notePath(id), external)
    vault.updateDoc(body('local edit'))

    await vault.flush()
    expect(vault.diskConflicts.map((item) => item.id)).toEqual([id])
    expect(vault.diskConflicts[0]?.note?.title).toBe('External')
    expect(vault.diskConflicts[0]?.undoable).toBe(true)
    expect(vault.pendingId).toBe(id)
    expect(vault.saveStatus).toBe('idle')
    expect(await vault.fs!.readText(notePath(id))).toBe(external)
    expect(plainText(vault.active!.doc)).toContain('local edit')
    expect(vault.docEpoch).toBe(epoch)

    vault.updateDoc(body('local edit again'))
    await vault.flush()
    expect(vault.saveStatus).toBe('idle')
    expect(vault.pendingId).toBe(id)
    expect(await vault.fs!.readText(notePath(id))).toBe(external)

    await vault.refreshFromDisk()
    expect(vault.docEpoch).toBe(epoch)
    expect(plainText(vault.active!.doc)).toContain('local edit')
    expect(await vault.fs!.readText(notePath(id))).toBe(external)
    expect(vault.diskConflicts).toHaveLength(1)
  })

  it('stores the post-write mtime so the next flush is not a false conflict', async () => {
    const vault = await opened()
    await vault.createNote()
    const id = vault.activeId
    await storeMtime(vault, id)
    vault.updateDoc(body('first save'))
    await vault.flush()
    expect(vault.diskConflicts).toEqual([])
    expect(vault.noteMtimes[id]).toBe(await fileMtime(vault, id))

    vault.updateDoc(body('second save'))
    await vault.flush()
    expect(vault.diskConflicts).toEqual([])
    expect(plainText((await readNoteFile(vault.fs!, notePath(id), id)).doc)).toContain('second save')
    expect(vault.noteMtimes[id]).toBe(await fileMtime(vault, id))
  })

  it('stores a real mtime after mutateNotes and restoreActiveNote', async () => {
    const vault = await opened()
    await vault.createNote()
    const id = vault.activeId
    await storeMtime(vault, id)
    await vault.retypeNotes([id], 'Project')
    expect(vault.notes.find((note) => note.id === id)?.type).toBe('Project')
    expect(vault.noteMtimes[id]).toBe(await fileMtime(vault, id))
    vault.updateDoc(body('after retype'))
    await vault.flush()
    expect(vault.diskConflicts).toEqual([])

    const restored = serializeNote({ ...vault.active!, doc: body('from history') })
    await vault.restoreActiveNote(restored)
    expect(plainText(vault.active!.doc)).toContain('from history')
    expect(vault.noteMtimes[id]).toBe(await fileMtime(vault, id))
    expect(vault.diskConflicts).toEqual([])
    vault.updateDoc(body('after restore'))
    await vault.flush()
    expect(vault.diskConflicts).toEqual([])
    expect(plainText((await readNoteFile(vault.fs!, notePath(id), id)).doc)).toContain('after restore')
  })

  it('lets Keep draft save over the external file and Load disk replace memory without writing', async () => {
    const vault = await opened()
    await vault.createNote()
    const id = vault.activeId
    await storeMtime(vault, id)
    const external = serializeNote(createNote(id, 'External'))
    await vault.fs!.writeText(notePath(id), external)
    const observed = await fileMtime(vault, id)
    vault.updateDoc(body('local edit'))
    await vault.flush()
    expect(vault.diskConflicts[0]?.mtimeMs).toBe(observed)
    const epoch = vault.docEpoch
    const writes = vi.spyOn(vault.fs!, 'writeText')

    loadDiskConflict(vault, id)
    expect(writes).not.toHaveBeenCalled()
    expect(vault.diskConflicts).toEqual([])
    expect(vault.pendingId).toBe('')
    expect(plainText(vault.active!.doc)).not.toContain('local edit')
    expect(vault.active?.title).toBe('External')
    expect(vault.docEpoch).toBe(epoch + 1)
    expect(vault.noteMtimes[id]).toBe(observed)
    expect(await vault.fs!.readText(notePath(id))).toBe(external)
    await vault.flush()
    expect(writes).not.toHaveBeenCalled()

    vault.updateDoc(body('local edit'))
    await vault.fs!.writeText(notePath(id), external)
    await vault.flush()
    expect(vault.diskConflicts.map((item) => item.id)).toEqual([id])
    writes.mockClear()
    await keepDraftConflict(vault, id)
    expect(vault.diskConflicts).toEqual([])
    expect(plainText((await readNoteFile(vault.fs!, notePath(id), id)).doc)).toContain('local edit')
    expect(vault.noteMtimes[id]).toBe(await fileMtime(vault, id))
    expect(writes).toHaveBeenCalled()
  })

  it('recreates a missing file once after Keep draft and keeps the allow when that save fails', async () => {
    const vault = await opened()
    await vault.createNote()
    const id = vault.activeId
    await storeMtime(vault, id)
    await vault.fs!.remove(notePath(id))
    vault.updateDoc(body('bring back'))
    await vault.flush()
    expect(vault.diskConflicts[0]).toMatchObject({ id, mtimeMs: null, note: null, undoable: false })
    expect(await vault.fs!.stat(notePath(id))).toBeNull()

    const fs = vault.fs!
    const original = fs.writeText.bind(fs)
    let failed = false
    fs.writeText = async (path, data) => {
      if (!failed && path === notePath(id)) {
        failed = true
        throw new Error('disk full')
      }
      return original(path, data)
    }
    await keepDraftConflict(vault, id)
    expect(vault.diskConflicts).toEqual([])
    expect(await fs.stat(notePath(id))).toBeNull()
    expect(vault.saveStatus).toBe('error')
    fs.writeText = original
    await vault.flush()
    expect(plainText((await readNoteFile(fs, notePath(id), id)).doc)).toContain('bring back')
    expect(vault.noteMtimes[id]).toBe(await fileMtime(vault, id))
    expect(vault.diskConflicts).toEqual([])
  })

  it('does not read a changed file larger than 128KiB and does not let a tool write over a conflict', async () => {
    const vault = await opened()
    await vault.createNote()
    const id = vault.activeId
    await storeMtime(vault, id)
    const bytes = new Uint8Array(128 * 1024 + 1)
    await vault.fs!.writeBytes(notePath(id), bytes)
    const readBytes = vi.spyOn(vault.fs!, 'readBytes')
    vault.updateDoc(body('local edit'))
    await vault.flush()
    expect(readBytes).not.toHaveBeenCalled()
    expect(vault.diskConflicts[0]).toMatchObject({ id, undoable: false, note: null, size: bytes.byteLength })
    expect((await vault.fs!.stat(notePath(id)))?.size).toBe(bytes.byteLength)
    await vault.writeExternalNote(id, serializeNote(createNote(id, 'Tool')))
    expect((await vault.fs!.stat(notePath(id)))?.size).toBe(bytes.byteLength)
    expect(plainText(vault.active!.doc)).toContain('local edit')
  })

  it('does not evict the unresolved conflict for the current pending note', () => {
    const vault = new VaultService()
    vault.pendingId = 'keep'
    rememberDiskConflict(vault, { id: 'keep', mtimeMs: 1, size: 1, note: createNote('keep', 'Keep'), undoable: true })
    for (let index = 0; index < 8; index += 1) {
      const id = `n${index}`
      rememberDiskConflict(vault, { id, mtimeMs: index, size: 1, note: null, undoable: false })
    }
    expect(vault.diskConflicts).toHaveLength(8)
    expect(vault.diskConflicts.map((item) => item.id)).toEqual(['keep', 'n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7'])
  })

  it('does not record a conflict for a title baseline or a note with no stored mtime', async () => {
    const vault = await opened()
    await vault.createNote()
    const id = vault.activeId
    await storeMtime(vault, id)
    const epoch = vault.docEpoch
    vault.updateTitle('Renamed moss')
    await vault.flush()
    expect(vault.diskConflicts).toEqual([])
    expect(vault.noteMtimes[id]).toBe(await fileMtime(vault, id))
    expect(vault.active?.title).toBe('Renamed moss')

    const external = serializeNote(createNote(id, 'External title'))
    await vault.fs!.writeText(notePath(id), external)
    await vault.refreshFromDisk()
    expect(vault.diskConflicts).toEqual([])
    expect(vault.active?.title).toBe('Renamed moss')
    expect(vault.docEpoch).toBe(epoch)
    expect(await vault.fs!.readText(notePath(id))).toBe(external)

    delete vault.noteMtimes[id]
    vault.updateDoc(body('no baseline'))
    await vault.flush()
    expect(vault.diskConflicts).toEqual([])
    expect(plainText((await readNoteFile(vault.fs!, notePath(id), id)).doc)).toContain('no baseline')
    expect(vault.noteMtimes[id]).toBe(await fileMtime(vault, id))
  })

  it('refreshes on window focus and skips the refresh while hidden', async () => {
    const vault = await openMemory()
    const fs = vault.fs!
    await fs.mkdir('quiet')
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 350))
    expect(resolve(FolderService).folders).not.toContain('quiet')

    const descriptor = Object.getOwnPropertyDescriptor(document, 'visibilityState')
    try {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
      window.dispatchEvent(new Event('focus'))
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 350))
      expect(resolve(FolderService).folders).not.toContain('quiet')

      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
      document.dispatchEvent(new Event('visibilitychange'))
      await vi.waitFor(() => {
        expect(resolve(FolderService).folders).toContain('quiet')
      })
    } finally {
      if (descriptor) Object.defineProperty(document, 'visibilityState', descriptor)
    }
  })
})
