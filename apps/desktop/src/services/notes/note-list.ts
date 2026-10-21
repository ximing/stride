// Pure NoteList logic: virtual-scroll windowing, sort comparators, the
// multi-select state machine, and per-vault sort persistence (`stride:list`).
// No rabjs or DOM dependencies so it stays unit-testable. NoteListService owns
// the reactive shell around these primitives.

import type { StrideNote } from '@stride/core/note'

/** Fixed row height in px. Must match `.note-list-item { height }` in styles.css. */
export const NOTE_ROW_HEIGHT = 66
/** Compact view mode row height. Must match `.note-list.is-compact .note-list-item { height }`. */
export const NOTE_ROW_HEIGHT_COMPACT = 48
/** Extra rows rendered above and below the viewport to absorb fast scrolls. */
export const NOTE_ROW_OVERSCAN = 6

export interface VirtualWindow {
  /** First rendered row index (inclusive). */
  start: number
  /** Last rendered row index (exclusive). */
  end: number
  /** Spacer height above the rendered rows. */
  topPad: number
  /** Spacer height below the rendered rows. */
  bottomPad: number
}

/**
 * Window of rows to render for a scroll position. Row height is fixed per view
 * mode (comfortable/compact), so the window is pure arithmetic; DOM node count
 * stays at viewport/ROW + 2*overscan regardless of `total`.
 */
export function virtualWindow(
  total: number,
  scrollTop: number,
  viewportHeight: number,
  overscan: number = NOTE_ROW_OVERSCAN,
  rowHeight: number = NOTE_ROW_HEIGHT,
): VirtualWindow {
  if (total <= 0) return { start: 0, end: 0, topPad: 0, bottomPad: 0 }
  const rawTop = Number.isFinite(scrollTop) ? Math.max(0, scrollTop) : 0
  const viewport = Number.isFinite(viewportHeight) ? Math.max(0, viewportHeight) : 0
  // Browsers clamp scrollTop to the scrollable range; mirror that so a stale
  // scroll position after a list shrink still yields a full window.
  const top = Math.min(rawTop, Math.max(0, total * rowHeight - viewport))
  const start = Math.max(0, Math.floor(top / rowHeight) - overscan)
  const lastVisible = Math.ceil((top + viewport) / rowHeight)
  const end = Math.min(total, Math.max(lastVisible + overscan, start))
  return {
    start,
    end,
    topPad: start * rowHeight,
    bottomPad: (total - end) * rowHeight,
  }
}

// ---------- sorting ----------

export type ListSortKey = 'mtime' | 'title' | 'created'
export type ListSortDir = 'asc' | 'desc'

export interface ListSort {
  key: ListSortKey
  dir: ListSortDir
}

export const LIST_SORT_KEYS: readonly ListSortKey[] = ['mtime', 'title', 'created']
export const DEFAULT_LIST_SORT: ListSort = { key: 'mtime', dir: 'desc' }

/** Creation time in ms: a `created` property (ISO string or epoch) wins, else the file mtime. */
export function noteCreatedMs(note: StrideNote, mtimes: Record<string, number>): number {
  const raw = note.properties.created
  const value = Array.isArray(raw) ? raw[0] : raw
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
    const numeric = Number(value)
    if (Number.isFinite(numeric)) return numeric
  }
  return mtimes[note.id] ?? 0
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/**
 * Sort by the given key. Decorate-sort-undecorate so 10k-note sorts pay one
 * key extraction per note instead of per comparison. Ties keep the original
 * position (stable) so equal-mtime lists never reshuffle under the user.
 */
export function sortNotes(
  notes: readonly StrideNote[],
  sort: ListSort,
  mtimes: Record<string, number>,
): StrideNote[] {
  const sign = sort.dir === 'asc' ? 1 : -1
  const keyed = notes.map((note, index) => ({
    note,
    index,
    title: note.title.toLowerCase(),
    mtime: mtimes[note.id] ?? 0,
    created: noteCreatedMs(note, mtimes),
  }))
  keyed.sort((a, b) => {
    let cmp = 0
    if (sort.key === 'title') cmp = compareText(a.title, b.title)
    else if (sort.key === 'created') cmp = a.created - b.created
    else cmp = a.mtime - b.mtime
    if (cmp === 0) return a.index - b.index
    return cmp * sign
  })
  return keyed.map((entry) => entry.note)
}

// ---------- multi-select state machine ----------

/** Mod+click: toggle one id in the selection. */
export function toggleInSelection(selection: readonly string[], id: string): string[] {
  return selection.includes(id) ? selection.filter((item) => item !== id) : [...selection, id]
}

/**
 * Shift+click: the inclusive range between anchor and target, in list order.
 * Unknown anchor/target collapses to whatever endpoint is known.
 */
export function rangeSelection(
  orderedIds: readonly string[],
  anchorId: string,
  targetId: string,
): string[] {
  const anchor = orderedIds.indexOf(anchorId)
  const target = orderedIds.indexOf(targetId)
  if (anchor === -1 && target === -1) return []
  if (anchor === -1) return [targetId]
  if (target === -1) return [anchorId]
  const [from, to] = anchor <= target ? [anchor, target] : [target, anchor]
  return orderedIds.slice(from, to + 1)
}

// ---------- sort persistence (`stride:list`, per-vault) ----------

export const LIST_STORAGE_KEY = 'stride:list'
export const LIST_FILE_VERSION = 1

interface ListFile {
  version: number
  vaults: Record<string, { sort: ListSort }>
}

/** Minimal storage contract so tests can pass a fake; localStorage satisfies it. */
export interface ListStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

function isListSortKey(value: unknown): value is ListSortKey {
  return typeof value === 'string' && (LIST_SORT_KEYS as readonly string[]).includes(value)
}

/** Validate arbitrary stored JSON into a ListSort. Garbage yields the default. */
export function sanitizeListSort(value: unknown): ListSort {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...DEFAULT_LIST_SORT }
  const raw = value as Record<string, unknown>
  const key = isListSortKey(raw.key) ? raw.key : DEFAULT_LIST_SORT.key
  const dir = raw.dir === 'asc' || raw.dir === 'desc' ? raw.dir : DEFAULT_LIST_SORT.dir
  return { key, dir }
}

function readListFile(storage: ListStorage | null): ListFile {
  const empty: ListFile = { version: LIST_FILE_VERSION, vaults: {} }
  if (!storage) return empty
  try {
    const raw = storage.getItem(LIST_STORAGE_KEY)
    if (!raw) return empty
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return empty
    const file = parsed as Record<string, unknown>
    if (file.version !== LIST_FILE_VERSION || !file.vaults || typeof file.vaults !== 'object' || Array.isArray(file.vaults)) {
      return empty
    }
    const vaults: ListFile['vaults'] = {}
    for (const [vaultId, prefs] of Object.entries(file.vaults as Record<string, unknown>)) {
      if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs)) continue
      vaults[vaultId] = { sort: sanitizeListSort((prefs as Record<string, unknown>).sort) }
    }
    return { version: LIST_FILE_VERSION, vaults }
  } catch {
    return empty
  }
}

/** The persisted sort for a vault, or the default when nothing valid is stored. */
export function readVaultSort(storage: ListStorage | null, vaultId: string): ListSort {
  if (!vaultId) return { ...DEFAULT_LIST_SORT }
  return readListFile(storage).vaults[vaultId]?.sort ?? { ...DEFAULT_LIST_SORT }
}

export function writeVaultSort(storage: ListStorage | null, vaultId: string, sort: ListSort): void {
  if (!storage || !vaultId) return
  try {
    const file = readListFile(storage)
    file.vaults[vaultId] = { sort: sanitizeListSort(sort) }
    storage.setItem(LIST_STORAGE_KEY, JSON.stringify(file))
  } catch {
    // Quota or privacy-mode failures must never break list interactions.
  }
}
