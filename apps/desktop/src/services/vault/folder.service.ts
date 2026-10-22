import { Service } from '@rabjs/react'
import {
  createFolder as createFolderOnDisk,
  deleteFolder as deleteFolderOnDisk,
  listFolders,
  moveNotePath,
  renameFolder as renameFolderOnDisk,
} from '../../../../../packages/core/src/folders'
import { applyNoteIdChanges, FOLDER_FILTER_PREFIX } from './note-identity'
import { VaultService } from './vault.service'

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class FolderService extends Service {
  folders: string[] = []

  private get vault() {
    return this.resolve(VaultService)
  }

  /** Folder path the note list is currently scoped to, '' when not in the folder dimension. */
  private folderFilterPath(): string {
    return this.vault.listFilter.startsWith(FOLDER_FILTER_PREFIX)
      ? this.vault.listFilter.slice(FOLDER_FILTER_PREFIX.length)
      : ''
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
      const changes = this.vault.notes
        .map((note) => ({ fromId: note.id, toId: nextId(note.id) }))
        .filter((change) => change.fromId !== change.toId)
      await applyNoteIdChanges(this.vault, changes, { remapFolderFilter: nextId })
      this.vault.docEpoch += 1
      this.vault.error = ''
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
      // Deleting the scoped folder (or one of its ancestors) drops the scope.
      const filterPath = this.folderFilterPath()
      if (filterPath === path || filterPath.startsWith(`${path}/`)) this.vault.listFilter = 'all'
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
   * createNote() resets the list filter to 'all'; a folder scope that still
   * contains the new note is restored so the list doesn't jump away.
   */
  async createNoteInFolder(path: string) {
    const filterPath = this.folderFilterPath()
    await this.vault.createNote()
    const id = this.vault.activeId
    if (!id || !path) return
    await this.moveNote(id, path)
    if (filterPath && (path === filterPath || path.startsWith(`${filterPath}/`))) {
      this.vault.listFilter = `${FOLDER_FILTER_PREFIX}${filterPath}`
    }
  }

  async moveNote(fromId: string, destFolder: string) {
    const fs = this.vault.fs
    if (!fs) return
    try {
      const toId = await moveNotePath(fs, fromId, destFolder)
      if (toId !== fromId) {
        await applyNoteIdChanges(this.vault, [{ fromId, toId }])
      }
      this.vault.docEpoch += 1
      this.vault.error = ''
      await this.loadFolders()
    } catch (error) {
      this.vault.error = errorText(error)
    }
  }
}
