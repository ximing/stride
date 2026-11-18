import type { LayoutStorage } from './layout'

export const FOLDER_TREE_STORAGE_PREFIX = 'stride:folder-tree:v1:'

/** Legacy global collapse records cannot be assigned to a vault safely. Start folded. */
export function readFolderTreeState(storage: LayoutStorage | null, vaultId: string): Record<string, boolean> {
  if (!vaultId || !storage) return {}
  try {
    const value: unknown = JSON.parse(storage.getItem(FOLDER_TREE_STORAGE_PREFIX + vaultId) ?? '[]')
    if (!Array.isArray(value)) return {}
    return Object.fromEntries(value.filter((path): path is string => typeof path === 'string' && path.length > 0).map(path => [path, true]))
  } catch {
    return {}
  }
}

export function writeFolderTreeState(storage: LayoutStorage | null, vaultId: string, expanded: Record<string, boolean>) {
  if (!vaultId || !storage) return
  try {
    storage.setItem(FOLDER_TREE_STORAGE_PREFIX + vaultId, JSON.stringify(Object.keys(expanded).filter(path => expanded[path] === true)))
  } catch {
    // Restricted or full storage must not interrupt tree interaction.
  }
}
