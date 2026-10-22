import type { VaultRecord } from './vault.service'

export const VAULT_REGISTRY_KEY = 'stride:vaults'

export const RECENT_PROJECT_LIMIT = 10

export interface RecentProject {
  id: string
  path: string
  title: string
  lastOpened: string
}

export function isVaultRecord(value: unknown): value is VaultRecord {
  if (!value || typeof value !== 'object') return false
  const record = value as Partial<VaultRecord>
  return typeof record.id === 'string' && record.id !== ''
    && typeof record.label === 'string'
    && typeof record.color === 'string'
    && typeof record.icon === 'string'
    && typeof record.lastOpened === 'string'
}

export function parseVaultRecords(raw: string | null): VaultRecord[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isVaultRecord)
  } catch {
    return []
  }
}

export function readStoredVaults(): VaultRecord[] {
  if (typeof localStorage === 'undefined') return []
  try {
    return parseVaultRecords(localStorage.getItem(VAULT_REGISTRY_KEY))
  } catch {
    return []
  }
}

/** Union by id. Stored order comes first; a newer `lastOpened` replaces the fields. */
export function mergeVaultRecords(local: readonly VaultRecord[], stored: readonly VaultRecord[]): VaultRecord[] {
  const order: string[] = []
  const byId = new Map<string, VaultRecord>()
  const take = (entry: VaultRecord) => {
    const previous = byId.get(entry.id)
    if (!previous) {
      order.push(entry.id)
      byId.set(entry.id, entry)
      return
    }
    if (entry.lastOpened >= previous.lastOpened) byId.set(entry.id, entry)
  }
  for (const entry of stored) take(entry)
  for (const entry of local) take(entry)
  return order.map((id) => byId.get(id)!)
}

/** Incoming membership wins. A strictly newer local stamp keeps the local fields. */
export function reconcileRegistry(local: readonly VaultRecord[], incoming: readonly VaultRecord[]): VaultRecord[] {
  const byId = new Map(local.map((entry) => [entry.id, entry]))
  return incoming.map((entry) => {
    const previous = byId.get(entry.id)
    if (previous && previous.lastOpened > entry.lastOpened) return previous
    return entry
  })
}

export function folderTitle(label: string): string {
  const trimmed = label.replace(/[\\/]+$/, '')
  const slash = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  const name = slash >= 0 ? trimmed.slice(slash + 1) : trimmed
  return name || label
}

/** Switcher and chooser name: a saved alias, otherwise the folder name, never the full path. */
export function vaultDisplayName(entry: { label: string; alias?: string }): string {
  const alias = typeof entry.alias === 'string' ? entry.alias.trim() : ''
  if (alias) return alias
  return folderTitle(entry.label)
}

const ABSOLUTE_PATH = /^(?:\/|[A-Za-z]:[\\/])/

export function recentProjectsFromRecords(records: readonly VaultRecord[]): RecentProject[] {
  return records
    .filter((entry) => ABSOLUTE_PATH.test(entry.label))
    .map((entry) => ({
      id: entry.id,
      path: entry.label,
      title: vaultDisplayName(entry),
      lastOpened: entry.lastOpened,
    }))
    .sort((left, right) => right.lastOpened.localeCompare(left.lastOpened) || left.path.localeCompare(right.path))
    .slice(0, RECENT_PROJECT_LIMIT)
}
