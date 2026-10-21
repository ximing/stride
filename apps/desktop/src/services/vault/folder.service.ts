import { has, resolve, Service } from '@rabjs/react'
import {
  createFolder as createFolderOnDisk,
  deleteFolder as deleteFolderOnDisk,
  listFolders,
  moveNotePath,
  renameFolder as renameFolderOnDisk,
} from '../../../../../packages/core/src/folders'
import { TabsService } from '../notes/tabs.service'
import { VaultService } from './vault.service'

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// Tabs keep per-tab history keyed by note id; folder renames/moves rewrite those
// ids in the same sync segment as the notes/activeId remap, so the TabsService
// convergence microtask never mistakes a move for a deletion.
function notifyTabsRemap(changes: { fromId: string; toId: string }[]) {
  if (!has(TabsService)) return
  const tabs = resolve(TabsService)
  for (const change of changes) tabs.remapNoteId(change.fromId, change.toId)
}

export class FolderService extends Service {
  folders: string[] = []

  private get vault() {
    return this.resolve(VaultService)
  }

  async loadFolders() {
    const fs = this.vault.fs
    if (!fs) {
      this.folders = []
      return
    }
    try {
      this.folders = await listFolders(fs)
    } catch (error) {
      this.vault.error = errorText(error)
    }
  }

  async createFolder(path: string) {
    const fs = this.vault.fs
    if (!fs) return
    try {
      await createFolderOnDisk(fs, path)
      this.vault.error = ''
      this.vault.docEpoch += 1
      await this.loadFolders()
    } catch (error) {
      this.vault.error = errorText(error)
    }
  }

  async renameFolder(from: string, to: string) {
    const fs = this.vault.fs
    if (!fs) return
    try {
      await renameFolderOnDisk(fs, from, to)
      const nextId = (id: string) =>
        id === from || id.startsWith(`${from}/`) ? to + id.slice(from.length) : id
      const changes: { fromId: string; toId: string }[] = []
      for (const note of this.vault.notes) {
        const id = nextId(note.id)
        if (id === note.id) continue
        this.vault.retargetTitleBaseline(note.id, id)
        changes.push({ fromId: note.id, toId: id })
      }
      this.vault.notes = this.vault.notes.map((note) => {
        const id = nextId(note.id)
        return id === note.id ? note : { ...note, id }
      })
      this.vault.activeId = nextId(this.vault.activeId)
      notifyTabsRemap(changes)
      this.vault.docEpoch += 1
      this.vault.error = ''
      await this.vault.syncMovedIds(changes)
      await this.loadFolders()
    } catch (error) {
      this.vault.error = errorText(error)
    }
  }

  async deleteFolder(path: string) {
    const fs = this.vault.fs
    if (!fs) return
    try {
      await deleteFolderOnDisk(
        fs,
        path,
        this.vault.notes.map((note) => note.id),
      )
      this.vault.error = ''
      this.vault.docEpoch += 1
      await this.loadFolders()
    } catch (error) {
      this.vault.error = errorText(error)
    }
  }

  /**
   * "New Note Here" from the folder context menu: create at the root via the
   * usual path (which selects the note), then move the file into `path` with
   * the same remap machinery as drag-and-drop. Empty path is a plain create.
   */
  async createNoteInFolder(path: string) {
    await this.vault.createNote()
    const id = this.vault.activeId
    if (!id || !path) return
    await this.moveNote(id, path)
  }

  async moveNote(fromId: string, destFolder: string) {
    const fs = this.vault.fs
    if (!fs) return
    try {
      const toId = await moveNotePath(fs, fromId, destFolder)
      if (toId !== fromId) {
        this.vault.notes = this.vault.notes.map((note) => (note.id === fromId ? { ...note, id: toId } : note))
        if (this.vault.activeId === fromId) this.vault.activeId = toId
        this.vault.retargetTitleBaseline(fromId, toId)
        notifyTabsRemap([{ fromId, toId }])
        await this.vault.syncMovedIds([{ fromId, toId }])
      }
      this.vault.docEpoch += 1
      this.vault.error = ''
      await this.loadFolders()
    } catch (error) {
      this.vault.error = errorText(error)
    }
  }
}
