import { has, resolve } from '@rabjs/react'
import { TabsService } from '../notes/tabs.service'
import type { VaultService } from './vault.service'

/** listFilter prefix for the folder dimension: `folder:<path>` (subtree match). */
export const FOLDER_FILTER_PREFIX = 'folder:'

export async function applyNoteIdChanges(
  vault: VaultService,
  changes: { fromId: string; toId: string }[],
  opts?: { remapFolderFilter?: (id: string) => string },
): Promise<void> {
  const moved = changes.filter((change) => change.fromId !== change.toId)
  if (moved.length > 0) {
    const byFrom = new Map(moved.map((change) => [change.fromId, change.toId]))
    vault.notes = vault.notes.map((note) => {
      const toId = byFrom.get(note.id)
      return toId ? { ...note, id: toId } : note
    })
    const nextActive = byFrom.get(vault.activeId)
    if (nextActive) vault.activeId = nextActive
    for (const change of moved) vault.retargetTitleBaseline(change.fromId, change.toId)
    if (has(TabsService)) {
      const tabs = resolve(TabsService)
      for (const change of moved) tabs.remapNoteId(change.fromId, change.toId)
    }
  }
  if (opts?.remapFolderFilter && vault.listFilter.startsWith(FOLDER_FILTER_PREFIX)) {
    const path = vault.listFilter.slice(FOLDER_FILTER_PREFIX.length)
    const remapped = opts.remapFolderFilter(path)
    if (remapped !== path) vault.listFilter = `${FOLDER_FILTER_PREFIX}${remapped}`
  }
  if (moved.length === 0) return
  await vault.syncMovedIds(moved)
}
