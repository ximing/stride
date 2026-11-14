// Pure baseline, file-activity rows, and undo packs for one external or bash turn.
// Pre-image bytes are stored and written back as-is. ChatService must not redact them.

import { NOTE_EXT, sha256HexSync } from '@stride/core'

/** Manifest rows kept for one turn. Past this, only open tabs and the active note remain. */
export const TURN_MANIFEST_CAP = 5000
/** Pre-image bodies retained for undo. */
export const TURN_BODY_FILE_CAP = 64
/** A larger serialized note keeps hash and size only. */
export const TURN_BODY_FILE_BYTES = 128 * 1024
/** Sum of retained pre-image bodies. */
export const TURN_BODY_TOTAL_BYTES = 4 * 1024 * 1024
/** File activity rows on the assistant message, before the single truncated row. */
export const TURN_FILE_ROW_CAP = 20
/** Undo packs kept per session. The caller passes paths oldest-first. */
export const TURN_PACKS_KEPT = 3
/** Serialized pack cap. Measured on `serializeTurnUndoPack`. */
export const TURN_PACK_MAX_BYTES = 4 * 1024 * 1024
export const FILE_CHANGE_DIFF_CHARS = 200

export const TURN_RESULT_UNDOABLE = 'undoable'
export const TURN_RESULT_TOO_LARGE = 'too large to undo'

export type TurnChangeKind = 'modified' | 'created' | 'deleted'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export interface TurnBaselineNote {
  id: string
  /** Serialized note text, or the UTF-8 bytes of that text. */
  serialized: Uint8Array | string
  mtime: number
}

export interface TurnManifestEntry {
  id: string
  mtime: number
  sha256: string
  size: number
  undoable: boolean
  /** Pre-image text. Present only when `undoable`. Not redacted. */
  bytes?: string
}

export interface TurnBaseline {
  partial: boolean
  /** Open tabs, then the active note, then the smallest serialized bodies. */
  entries: TurnManifestEntry[]
}

export interface TurnNoteChange {
  id: string
  change: TurnChangeKind
  undoable: boolean
  /** End hash for modified and created; baseline hash for deleted. */
  sha256: string
  size: number
  /** Pre-image for an undoable modify or delete. Absent for creates and oversized notes. */
  bytes?: string
}

export type TurnActivityRow =
  | {
      id: string
      name: 'file'
      args: { id: string; change: TurnChangeKind }
      result: typeof TURN_RESULT_UNDOABLE | typeof TURN_RESULT_TOO_LARGE
    }
  | {
      id: 'truncated'
      name: 'truncated'
      args: null
      result: string
    }

export interface TurnDiff {
  partial: boolean
  /** Every note change. This is not what the chat row stores. */
  changes: TurnNoteChange[]
  /** At most 20 file rows, plus one truncated row when more changes exist. */
  rows: TurnActivityRow[]
}

export interface TurnUndoFile {
  id: string
  change: TurnChangeKind
  undoable: true
  sha256: string
  size: number
  /** Pre-image for modify and delete. Omitted for creates. Not redacted. */
  bytes?: string
}

export interface TurnUndoPack {
  format: 1
  vaultKey: string
  sessionId: string
  turnId: string
  /** Caller-supplied clock, so pruning can order packs without app-data mtimes. */
  writtenAt: string
  partial: boolean
  files: TurnUndoFile[]
}

export interface TurnUndoPackOptions {
  vaultKey: string
  sessionId: string
  turnId: string
  writtenAt: string
  /**
   * Power shell packs omit ids touched by writeSerialized, deleteNote, and both
   * the argument id and the returned id of moveNote. External CLI packs omit this.
   */
  excludeIds?: ReadonlySet<string>
}

export interface TurnUndoLive {
  id: string
  serialized: Uint8Array | string
  /** False when the path is no longer a `*.stride.json` note. Defaults to still a note. */
  note?: boolean
}

export type TurnUndoStep =
  | { op: 'write'; id: string; bytes: string }
  | { op: 'delete'; id: string }
  | { op: 'openBanner'; id: string }
  | { op: 'skip'; id: string; reason: 'changed' | 'missing' | 'not-note' }

export interface TurnUndoPlan {
  steps: TurnUndoStep[]
  /** Created notes left in place because the user edited them after the turn. */
  skippedIds: string[]
}

export interface FileChangeSnapshot {
  path: string
  diff?: string
}

interface PreparedNote {
  id: string
  mtime: number
  bytes: Uint8Array
  /** Original string, when the caller passed one. Decoded later only if the body is kept. */
  text: string | null
}

/** Vault note id. `.git` and `.stride` path segments are never undo targets. */
export function isTurnNoteId(id: string): boolean {
  if (!id || /[\0\\]/.test(id) || id.startsWith('/') || /^[A-Za-z]:/.test(id)) return false
  return id.split('/').every((part) => part !== '' && part !== '.' && part !== '..' && part !== '.git' && part !== '.stride')
}

/** True for a `*.stride.json` path that is not inside `.git` or `.stride`. */
export function isUndoableNotePath(path: string): boolean {
  const normalized = path.replaceAll('\\', '/').replace(/^\/+/, '')
  if (!normalized.endsWith(NOTE_EXT)) return false
  return isTurnNoteId(normalized.slice(0, -NOTE_EXT.length))
}

export function captureTurnBaseline(input: {
  notes: readonly TurnBaselineNote[]
  openTabIds?: readonly string[]
  activeId?: string | null
}): TurnBaseline {
  const { ordered, partial } = orderBaseline(input.notes, input.openTabIds ?? [], input.activeId ?? null)
  const entries: TurnManifestEntry[] = []
  let kept = 0
  let keptBytes = 0
  for (const note of ordered) {
    const entry: TurnManifestEntry = {
      id: note.id,
      mtime: note.mtime,
      sha256: sha256HexSync(note.bytes),
      size: note.bytes.byteLength,
      undoable: false,
    }
    const room = kept < TURN_BODY_FILE_CAP && keptBytes + note.bytes.byteLength <= TURN_BODY_TOTAL_BYTES
    if (note.bytes.byteLength <= TURN_BODY_FILE_BYTES && room) {
      entry.undoable = true
      entry.bytes = note.text ?? decoder.decode(note.bytes)
      kept += 1
      keptBytes += note.bytes.byteLength
    }
    entries.push(entry)
  }
  return { partial, entries }
}

/**
 * Content hash decides. The same bytes are unchanged even if mtime moved;
 * different bytes are modified even if mtime matches.
 * A partial baseline has no full id list, so notes outside it are not reported as created.
 */
export function diffTurnNotes(baseline: TurnBaseline, current: readonly TurnBaselineNote[]): TurnDiff {
  const live = indexNotes(current)
  const known = new Set(baseline.entries.map((entry) => entry.id))
  const changes: TurnNoteChange[] = []
  for (const entry of baseline.entries) {
    const note = live.get(entry.id)
    if (!note) {
      changes.push({
        id: entry.id,
        change: 'deleted',
        undoable: entry.undoable && entry.bytes != null,
        sha256: entry.sha256,
        size: entry.size,
        ...(entry.undoable && entry.bytes != null ? { bytes: entry.bytes } : {}),
      })
      continue
    }
    const end = digest(note.serialized)
    if (end.sha256 === entry.sha256) continue
    changes.push({
      id: entry.id,
      change: 'modified',
      undoable: entry.undoable && entry.bytes != null,
      sha256: end.sha256,
      size: end.size,
      ...(entry.undoable && entry.bytes != null ? { bytes: entry.bytes } : {}),
    })
  }
  if (!baseline.partial) {
    for (const note of live.values()) {
      if (known.has(note.id)) continue
      const end = digest(note.serialized)
      changes.push({
        id: note.id,
        change: 'created',
        undoable: true,
        sha256: end.sha256,
        size: end.size,
      })
    }
  }
  return { partial: baseline.partial, changes, rows: activityRows(changes) }
}

/** Undoable note changes only. Excluded ids are omitted. The JSON stays within 4MiB. */
export function buildTurnUndoPack(diff: TurnDiff, options: TurnUndoPackOptions): TurnUndoPack {
  const vaultKey = pathSegment(options.vaultKey, 'vault key')
  const sessionId = pathSegment(options.sessionId, 'session id')
  const turnId = pathSegment(options.turnId, 'turn id')
  const files: TurnUndoFile[] = []
  for (const change of diff.changes) {
    if (!change.undoable || !isTurnNoteId(change.id) || options.excludeIds?.has(change.id)) continue
    if (change.change !== 'created' && change.bytes == null) continue
    const file: TurnUndoFile = {
      id: change.id,
      change: change.change,
      undoable: true,
      sha256: change.sha256,
      size: change.size,
    }
    if (change.change !== 'created' && change.bytes != null) file.bytes = change.bytes
    files.push(file)
  }
  const pack: TurnUndoPack = {
    format: 1,
    vaultKey,
    sessionId,
    turnId,
    writtenAt: options.writtenAt,
    partial: diff.partial,
    files,
  }
  while (packByteLength(pack) > TURN_PACK_MAX_BYTES && pack.files.length > 0) {
    pack.files.splice(dropIndex(pack.files), 1)
  }
  return pack
}

export function serializeTurnUndoPack(pack: TurnUndoPack): string {
  return JSON.stringify(pack)
}

export function parseTurnUndoPack(raw: string): TurnUndoPack | null {
  try {
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const record = value as Record<string, unknown>
    if (record.format !== 1 || typeof record.partial !== 'boolean') return null
    if (typeof record.vaultKey !== 'string' || typeof record.sessionId !== 'string') return null
    if (typeof record.turnId !== 'string' || typeof record.writtenAt !== 'string') return null
    if (!Array.isArray(record.files) || record.files.some((file) => !file || typeof file !== 'object')) return null
    return value as TurnUndoPack
  } catch {
    return null
  }
}

export function turnPackHasUndo(pack: TurnUndoPack): boolean {
  return pack.files.some((file) => file.undoable && isTurnNoteId(file.id))
}

/**
 * One undo click.
 * Modified notes in `blockedIds` (dirty, or an unresolved disk conflict) become `openBanner` and are not written.
 * A created note is deleted only when it is still a note and its hash still matches the end of the turn.
 * A deleted note is written back when the pack kept a pre-image.
 */
export function planTurnUndo(
  pack: TurnUndoPack,
  current: readonly TurnUndoLive[],
  blockedIds: ReadonlySet<string>,
): TurnUndoPlan {
  const live = new Map<string, TurnUndoLive>()
  for (const note of current) {
    if (!live.has(note.id)) live.set(note.id, note)
  }
  const steps: TurnUndoStep[] = []
  const skippedIds: string[] = []
  for (const file of pack.files) {
    if (!isTurnNoteId(file.id)) {
      steps.push({ op: 'skip', id: file.id, reason: 'not-note' })
      continue
    }
    if (file.change === 'created') {
      const note = live.get(file.id)
      if (!note) {
        steps.push({ op: 'skip', id: file.id, reason: 'missing' })
        continue
      }
      if (note.note === false) {
        steps.push({ op: 'skip', id: file.id, reason: 'not-note' })
        continue
      }
      if (digest(note.serialized).sha256 !== file.sha256) {
        steps.push({ op: 'skip', id: file.id, reason: 'changed' })
        skippedIds.push(file.id)
        continue
      }
      steps.push({ op: 'delete', id: file.id })
      continue
    }
    if (file.change === 'modified' && blockedIds.has(file.id)) {
      steps.push({ op: 'openBanner', id: file.id })
      continue
    }
    if (file.bytes == null) {
      steps.push({ op: 'skip', id: file.id, reason: 'missing' })
      continue
    }
    steps.push({ op: 'write', id: file.id, bytes: file.bytes })
  }
  return { steps, skippedIds }
}

export function turnPackPath(vaultKey: string, sessionId: string, turnId: string): string {
  return `${turnPackListPrefix(vaultKey, sessionId)}${pathSegment(turnId, 'turn id')}.json`
}

/**
 * `agent-turns/<vaultKey>/<sessionId>/`.
 * The caller lists this prefix and `remove`s each path from `turnPackRemovePaths`.
 * `AppDataStore.remove` deletes one file, so never remove this prefix itself.
 */
export function turnPackListPrefix(vaultKey: string, sessionId: string): string {
  return `agent-turns/${pathSegment(vaultKey, 'vault key')}/${pathSegment(sessionId, 'session id')}/`
}

/** Paths to delete so only the newest `keep` file packs remain. `paths` is oldest first. Directory paths are ignored. */
export function turnPacksToDelete(paths: readonly string[], keep = TURN_PACKS_KEPT): string[] {
  const files = paths.filter(isListedFile)
  if (files.length <= keep) return []
  return files.slice(0, files.length - keep)
}

/** `list()` paths that are safe to `remove`. Never a directory prefix. */
export function turnPackRemovePaths(listed: readonly string[]): string[] {
  return listed.filter(isListedFile)
}

/**
 * Codex `fileChange` tool-row text. The diff is capped at 200 characters and
 * belongs on the row only — undo packs do not store it.
 */
export function formatFileChangeResult(status: string, changes: readonly FileChangeSnapshot[]): string {
  const parts: string[] = []
  if (status) parts.push(status)
  if (changes.some((change) => !isUndoableNotePath(change.path))) parts.push('undo unavailable')
  const diff = changes
    .map((change) => change.diff ?? '')
    .filter((part) => part !== '')
    .join('\n')
    .slice(0, FILE_CHANGE_DIFF_CHARS)
  if (diff) parts.push(diff)
  return parts.join('; ')
}

function orderBaseline(
  notes: readonly TurnBaselineNote[],
  openTabIds: readonly string[],
  activeId: string | null,
): { ordered: PreparedNote[]; partial: boolean } {
  const byId = new Map<string, TurnBaselineNote>()
  for (const note of notes) {
    if (!isTurnNoteId(note.id) || byId.has(note.id)) continue
    byId.set(note.id, note)
  }
  const open: TurnBaselineNote[] = []
  const seen = new Set<string>()
  for (const id of openTabIds) {
    if (seen.has(id)) continue
    const note = byId.get(id)
    if (!note) continue
    seen.add(id)
    open.push(note)
  }
  const active = activeId && !seen.has(activeId) ? byId.get(activeId) : undefined
  if (byId.size > TURN_MANIFEST_CAP) {
    const room = active ? TURN_MANIFEST_CAP - 1 : TURN_MANIFEST_CAP
    const kept = open.slice(0, Math.max(room, 0))
    if (active) kept.push(active)
    return { ordered: kept.map(prepare), partial: true }
  }
  const rest: TurnBaselineNote[] = []
  for (const note of byId.values()) {
    if (seen.has(note.id)) continue
    if (active && note.id === active.id) continue
    rest.push(note)
  }
  const preparedRest = rest.map(prepare).sort((left, right) => {
    const size = left.bytes.byteLength - right.bytes.byteLength
    if (size !== 0) return size
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
  })
  return {
    ordered: [...open.map(prepare), ...(active ? [prepare(active)] : []), ...preparedRest],
    partial: false,
  }
}

function prepare(note: TurnBaselineNote): PreparedNote {
  if (typeof note.serialized === 'string') {
    return { id: note.id, mtime: note.mtime, bytes: encoder.encode(note.serialized), text: note.serialized }
  }
  return { id: note.id, mtime: note.mtime, bytes: note.serialized, text: null }
}

function digest(serialized: Uint8Array | string): { sha256: string; size: number } {
  const bytes = typeof serialized === 'string' ? encoder.encode(serialized) : serialized
  return { sha256: sha256HexSync(bytes), size: bytes.byteLength }
}

function indexNotes(notes: readonly TurnBaselineNote[]): Map<string, TurnBaselineNote> {
  const map = new Map<string, TurnBaselineNote>()
  for (const note of notes) {
    if (!isTurnNoteId(note.id) || map.has(note.id)) continue
    map.set(note.id, note)
  }
  return map
}

function activityRows(changes: readonly TurnNoteChange[]): TurnActivityRow[] {
  const rows: TurnActivityRow[] = changes.slice(0, TURN_FILE_ROW_CAP).map((change) => ({
    id: `file:${change.id}:${change.change}`,
    name: 'file',
    args: { id: change.id, change: change.change },
    result: change.undoable ? TURN_RESULT_UNDOABLE : TURN_RESULT_TOO_LARGE,
  }))
  const extra = changes.length - rows.length
  if (extra > 0) rows.push({ id: 'truncated', name: 'truncated', args: null, result: `${extra} more events omitted` })
  return rows
}

function packByteLength(pack: TurnUndoPack): number {
  return encoder.encode(serializeTurnUndoPack(pack)).byteLength
}

/** Lowest-priority file, preferring the largest body so small creates stay. */
function dropIndex(files: readonly TurnUndoFile[]): number {
  let index = files.length - 1
  let largest = -1
  for (let i = 0; i < files.length; i += 1) {
    const bytes = files[i]?.bytes
    const size = bytes ? encoder.encode(bytes).byteLength : 0
    if (size >= largest) {
      largest = size
      index = i
    }
  }
  return index
}

function pathSegment(value: string, label: string): string {
  if (!value || value === '.' || value === '..' || value.includes('/') || value.includes('\\') || value.includes('\0')) {
    throw new Error(`Invalid ${label}`)
  }
  return value
}

function isListedFile(path: string): boolean {
  if (!path || path.endsWith('/') || path.endsWith('\\')) return false
  const normalized = path.replaceAll('\\', '/')
  const base = normalized.slice(normalized.lastIndexOf('/') + 1)
  return base.includes('.') && base !== '.' && base !== '..'
}
