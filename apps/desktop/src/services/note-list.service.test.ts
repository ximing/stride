import { register, resolve } from '@rabjs/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { notePath, readNoteFile } from '../../../../packages/core/src/vault'
import {
  DEFAULT_LIST_SORT,
  LIST_STORAGE_KEY,
  readVaultSort,
  writeVaultSort,
} from './note-list'
import { NoteListService } from './note-list.service'
import { VaultService } from './vault.service'

function useMemoryFixture() {
  window.history.replaceState(null, '', '/?fixture=memory')
}

async function openMemoryVault(): Promise<VaultService> {
  useMemoryFixture()
  vi.stubGlobal('showDirectoryPicker', vi.fn())
  register(VaultService)
  const vault = resolve(VaultService)
  vault.cancelPending()
  await vault.openFromDraft()
  return vault
}

async function createThreeNotes(vault: VaultService): Promise<string[]> {
  await vault.createNote()
  await vault.createNote()
  await vault.createNote()
  return vault.notes.map((note) => note.id)
}

describe('NoteListService selection', () => {
  afterEach(() => {
    const list = resolve(NoteListService)
    list.clearSelection()
    list.sort = { ...DEFAULT_LIST_SORT }
    window.history.replaceState(null, '', '/')
    localStorage.removeItem(LIST_STORAGE_KEY)
    vi.unstubAllGlobals()
    try {
      resolve(VaultService).cancelPending()
    } catch {
      // not registered in this test
    }
  })

  it('plain click single-selects and opens the note; Mod toggles; Shift ranges', async () => {
    const vault = await openMemoryVault()
    const ids = await createThreeNotes(vault)
    const list = resolve(NoteListService)
    const order = [...ids] // rendered order the list would pass

    list.clickNote(ids[0]!, { shift: false, mod: false }, order)
    expect(list.selectedIds).toEqual([ids[0]])
    expect(vault.activeId).toBe(ids[0])

    list.clickNote(ids[1]!, { shift: false, mod: true }, order)
    expect(list.selectedIds).toEqual([ids[0], ids[1]])
    expect(list.hasMultiSelection).toBe(true)

    // Shift from the anchor extends over the explicit row order.
    list.clickNote(ids[0]!, { shift: false, mod: false }, order)
    list.clickNote(ids[2]!, { shift: true, mod: false }, order)
    expect(list.selectedIds).toEqual([ids[0], ids[1], ids[2]])

    // Mod-click on a selected id removes it.
    list.clickNote(ids[1]!, { shift: false, mod: true }, order)
    expect(list.selectedIds).toEqual([ids[0], ids[2]])

    list.clearSelection()
    expect(list.selectionCount).toBe(0)
    expect(list.anchorId).toBe('')
  })

  it('persists sort per vault and reloads it on vault open', async () => {
    const vault = await openMemoryVault()
    const list = resolve(NoteListService)
    const vaultId = vault.activeVaultId
    expect(vaultId).not.toBe('')

    list.setSort({ key: 'title', dir: 'asc' })
    expect(readVaultSort(localStorage, vaultId)).toEqual({ key: 'title', dir: 'asc' })

    // A fresh open of the same vault reloads the persisted sort.
    list.sort = { ...DEFAULT_LIST_SORT }
    ;(list as unknown as { sortVaultKey: string }).sortVaultKey = ''
    list.onVaultOpened()
    expect(list.sort).toEqual({ key: 'title', dir: 'asc' })

    // A different vault id falls back to the default.
    expect(readVaultSort(localStorage, 'someone-else')).toEqual(DEFAULT_LIST_SORT)
    writeVaultSort(localStorage, 'someone-else', { key: 'created', dir: 'asc' })
    expect(readVaultSort(localStorage, 'someone-else')).toEqual({ key: 'created', dir: 'asc' })
  })
})

describe('VaultService batch operations', () => {
  afterEach(() => {
    resolve(NoteListService).clearSelection()
    window.history.replaceState(null, '', '/')
    vi.unstubAllGlobals()
    try {
      resolve(VaultService).cancelPending()
    } catch {
      // not registered in this test
    }
  })

  it('archiveNotes marks each note archived on disk and hides it from the list', async () => {
    const vault = await openMemoryVault()
    const ids = await createThreeNotes(vault)
    const [first, second] = ids
    expect(vault.visibleNotes.length).toBe(3)

    await vault.archiveNotes([first!, second!])
    const byId = new Map(vault.notes.map((note) => [note.id, note]))
    expect(byId.get(first!)?.properties.archived).toBe(true)
    expect(byId.get(second!)?.properties.archived).toBe(true)
    expect(vault.visibleNotes.some((note) => note.id === first)).toBe(false)
    expect(vault.visibleNotes.length).toBe(1)

    const onDisk = await readNoteFile(vault.fs!, notePath(first!), first!)
    expect(onDisk.properties.archived).toBe(true)
  })

  it('retypeNotes changes the type of each note and saves', async () => {
    const vault = await openMemoryVault()
    const ids = await createThreeNotes(vault)
    await vault.retypeNotes([ids[0]!, ids[1]!], 'Project')
    const byId = new Map(vault.notes.map((note) => [note.id, note]))
    expect(byId.get(ids[0]!)?.type).toBe('Project')
    expect(byId.get(ids[1]!)?.type).toBe('Project')
    expect(byId.get(ids[2]!)?.type).toBe('note')
    const onDisk = await readNoteFile(vault.fs!, notePath(ids[0]!), ids[0]!)
    expect(onDisk.type).toBe('Project')
    await vault.retypeNotes([ids[2]!], '   ')
    expect(byId.get(ids[2]!)?.type).toBe('note')
  })

  it('deleteNotes removes files, drops mtimes, and moves the active selection', async () => {
    const vault = await openMemoryVault()
    const ids = await createThreeNotes(vault)
    const list = resolve(NoteListService)
    list.clickNote(ids[0]!, { shift: false, mod: false }, ids)
    expect(vault.activeId).toBe(ids[0])
    expect(await vault.fs!.stat(notePath(ids[0]!))).not.toBeNull()

    await vault.deleteNotes([ids[0]!, ids[1]!])
    expect(await vault.fs!.stat(notePath(ids[0]!))).toBeNull()
    expect(await vault.fs!.stat(notePath(ids[1]!))).toBeNull()
    expect(vault.notes.some((note) => note.id === ids[0])).toBe(false)
    expect(vault.notes.some((note) => note.id === ids[1])).toBe(false)
    expect(vault.noteMtimes[ids[0]!]).toBeUndefined()
    expect(vault.activeId).toBe(ids[2])
  })

  it('service batch helpers forward to the vault and clear the selection', async () => {
    const vault = await openMemoryVault()
    const ids = await createThreeNotes(vault)
    const list = resolve(NoteListService)

    list.clickNote(ids[0]!, { shift: false, mod: false }, ids)
    list.clickNote(ids[1]!, { shift: false, mod: true }, ids)
    await list.archiveSelected()
    expect(list.selectionCount).toBe(0)
    expect(vault.notes.find((note) => note.id === ids[0])?.properties.archived).toBe(true)

    list.clickNote(ids[2]!, { shift: false, mod: false }, ids)
    list.clickNote(ids[1]!, { shift: false, mod: true }, ids)
    list.confirmingDelete = true
    await list.deleteSelected()
    expect(list.confirmingDelete).toBe(false)
    expect(list.selectionCount).toBe(0)
    expect(vault.notes.some((note) => note.id === ids[2])).toBe(false)
    expect(vault.notes.some((note) => note.id === ids[1])).toBe(false)

    const remaining = vault.notes.filter((note) => !note.properties.archived)
    expect(remaining.length).toBe(0)

    // retypeSelected on an empty selection is a no-op.
    await list.retypeSelected('Project')
    expect(vault.error).toBe('')
  })
})
