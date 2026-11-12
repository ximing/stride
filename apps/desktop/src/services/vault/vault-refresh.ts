import { has, raw, resolve } from '@rabjs/react'
import {
  indexText,
  isNoteFileName,
  listFolders,
  listNoteFiles,
  NOTE_READ_CONCURRENCY,
  noteIdFromPath,
  readNoteFile,
  serializeNote,
  type StrideNote,
} from '@stride/core'
import { removeIndexed, upsertIndexed } from './vault-search-session'
import type { VaultService } from './vault.service'

/** Ids whose in-memory edits must win over the disk snapshot, plus the save generation that produced them. */
export interface RefreshBaseline {
  dirty: ReadonlySet<string>
  generation: number
}

export interface RefreshMergeInput {
  previous: readonly StrideNote[]
  /** Note ids present on disk. Unreadable files stay here without a parsed note. */
  diskIds: ReadonlySet<string>
  diskNotes: ReadonlyMap<string, StrideNote>
  /** Ids whose file mtime matched the stored value, so the body was not read. */
  unchangedIds: ReadonlySet<string>
  dirty: ReadonlySet<string>
  /** Ids in memory after the pre-scan flush. A later create is absent; a later delete is present. */
  beforeIds: ReadonlySet<string>
}

interface DiskSnapshot {
  diskIds: Set<string>
  diskNotes: Map<string, StrideNote>
  unchangedIds: Set<string>
  mtimes: Map<string, number>
  /** Null when this pass did not walk directories. */
  folders: string[] | null
}

interface PreparedRefresh {
  session: number
  baseline: RefreshBaseline
  started: Map<string, StrideNote>
  beforeIds: Set<string>
}

class RefreshAbort extends Error {}

let refreshTail: Promise<void> = Promise.resolve()

function enqueueVaultRefresh(job: () => Promise<void>): Promise<void> {
  const run = refreshTail.then(job, job)
  refreshTail = run.then(() => undefined, () => undefined)
  return run
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isUnreadableNote(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('is not TipTap JSON')
    || message.includes('is not a TipTap document')
    || message.includes('not Markdown frontmatter')
}

function parentFolder(id: string): string {
  const slash = id.lastIndexOf('/')
  return slash === -1 ? '' : id.slice(0, slash)
}

function notesOf(vault: VaultService): readonly StrideNote[] {
  return raw(vault.notes) as readonly StrideNote[]
}

function sameList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index])
}

/**
 * Merge a disk snapshot onto the latest in-memory notes.
 * Object identity is kept when the serialized file matches, so an unchanged
 * note does not reset the editor or the list.
 */
export function mergeRefreshedNotes(input: RefreshMergeInput): StrideNote[] {
  const { previous, diskIds, diskNotes, unchangedIds, dirty, beforeIds } = input
  const previousById = new Map(previous.map((note) => [note.id, note]))
  const chosen = new Map<string, StrideNote>()

  const consider = (id: string) => {
    if (chosen.has(id)) return
    const prev = previousById.get(id)
    if (prev && dirty.has(id)) {
      chosen.set(id, prev)
      return
    }
    if (!diskIds.has(id)) {
      if (prev && !beforeIds.has(id)) chosen.set(id, prev)
      return
    }
    // In memory at the start, gone now: the user deleted it while we were reading.
    if (!prev && beforeIds.has(id)) return
    if (prev && unchangedIds.has(id)) {
      chosen.set(id, prev)
      return
    }
    const disk = diskNotes.get(id)
    if (!disk) {
      if (prev) chosen.set(id, prev)
      return
    }
    if (prev && serializeNote(prev) === serializeNote(disk)) {
      chosen.set(id, prev)
      return
    }
    chosen.set(id, disk)
  }

  for (const note of previous) consider(note.id)
  const extras = [...diskIds].filter((id) => !previousById.has(id)).sort((left, right) => left.localeCompare(right))
  for (const id of extras) consider(id)

  const ordered: StrideNote[] = []
  for (const note of previous) {
    const next = chosen.get(note.id)
    if (next) ordered.push(next)
  }
  for (const id of extras) {
    const next = chosen.get(id)
    if (next) ordered.push(next)
  }
  return ordered
}

function sessionGone(vault: VaultService, session: number): boolean {
  return vault.session !== session || vault.phase !== 'ready' || !vault.fs
}

async function prepareRefresh(
  vault: VaultService,
  baselineOf: () => RefreshBaseline,
): Promise<PreparedRefresh | null> {
  if (vault.phase !== 'ready' || !vault.fs) return null
  const session = vault.session
  await vault.flush()
  if (sessionGone(vault, session)) return null
  const notes = notesOf(vault)
  const started = new Map(notes.map((note) => [note.id, note]))
  return {
    session,
    baseline: baselineOf(),
    started,
    beforeIds: new Set(started.keys()),
  }
}

function dirtyIds(vault: VaultService, prepared: PreparedRefresh, baselineOf: () => RefreshBaseline): Set<string> {
  const latest = baselineOf()
  const dirty = new Set<string>(prepared.baseline.dirty)
  for (const id of latest.dirty) dirty.add(id)
  if (latest.generation === prepared.baseline.generation) return dirty
  for (const note of notesOf(vault)) {
    if (prepared.started.get(note.id) !== note) dirty.add(note.id)
  }
  return dirty
}

async function pooled(items: readonly string[], worker: (item: string) => Promise<void>): Promise<void> {
  if (items.length === 0) return
  let cursor = 0
  let failure: unknown = null
  const run = async () => {
    while (failure === null) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      try {
        await worker(items[index]!)
      } catch (error) {
        failure = error
        return
      }
    }
  }
  const workers = Math.min(NOTE_READ_CONCURRENCY, items.length)
  await Promise.all(Array.from({ length: workers }, () => run()))
  if (failure) throw failure
}

async function readListedNotes(
  vault: VaultService,
  prepared: PreparedRefresh,
  files: readonly string[],
  snapshot: DiskSnapshot,
): Promise<void> {
  const fs = vault.fs
  if (!fs) throw new RefreshAbort()
  const previous = new Map(notesOf(vault).map((note) => [note.id, note]))
  await pooled(files, async (file) => {
    if (sessionGone(vault, prepared.session)) throw new RefreshAbort()
    const id = noteIdFromPath(file)
    snapshot.diskIds.add(id)
    const info = await fs.stat(file)
    if (sessionGone(vault, prepared.session)) throw new RefreshAbort()
    if (!info || info.kind !== 'file') {
      snapshot.diskIds.delete(id)
      return
    }
    const prev = previous.get(id)
    if (prev && vault.noteMtimes[id] === info.mtimeMs) {
      snapshot.unchangedIds.add(id)
      snapshot.mtimes.set(id, info.mtimeMs)
      return
    }
    try {
      snapshot.diskNotes.set(id, await readNoteFile(fs, file, id))
      snapshot.mtimes.set(id, info.mtimeMs)
    } catch (error) {
      if (!isUnreadableNote(error)) throw error
      if (!prepared.beforeIds.has(id)) snapshot.diskIds.delete(id)
    }
  })
}

async function scanFull(vault: VaultService, prepared: PreparedRefresh): Promise<DiskSnapshot | null> {
  const fs = vault.fs
  if (!fs || sessionGone(vault, prepared.session)) return null
  const [files, folders] = await Promise.all([listNoteFiles(fs), listFolders(fs)])
  if (sessionGone(vault, prepared.session)) return null
  const snapshot: DiskSnapshot = {
    diskIds: new Set(),
    diskNotes: new Map(),
    unchangedIds: new Set(),
    mtimes: new Map(),
    folders: folders.slice().sort(),
  }
  await readListedNotes(vault, prepared, files, snapshot)
  if (sessionGone(vault, prepared.session)) return null
  return snapshot
}

async function foldersIfParentsMissing(vault: VaultService, notePaths: readonly string[]): Promise<string[] | null> {
  const { FolderService } = await import('./folder.service')
  if (!has(FolderService)) return null
  const known = resolve(FolderService).folders
  const missing = notePaths.some((file) => {
    const parent = parentFolder(noteIdFromPath(file))
    return parent !== '' && !known.includes(parent)
  })
  if (!missing || !vault.fs) return null
  return (await listFolders(vault.fs)).slice().sort()
}

async function scanNotePaths(
  vault: VaultService,
  prepared: PreparedRefresh,
  notePaths: readonly string[],
): Promise<DiskSnapshot | null> {
  const fs = vault.fs
  if (!fs || sessionGone(vault, prepared.session)) return null
  const folders = await foldersIfParentsMissing(vault, notePaths)
  if (sessionGone(vault, prepared.session)) return null
  const snapshot: DiskSnapshot = {
    diskIds: new Set(prepared.beforeIds),
    diskNotes: new Map(),
    unchangedIds: new Set(prepared.beforeIds),
    mtimes: new Map(),
    folders,
  }
  const unique = [...new Set(notePaths)].filter((file) => isNoteFileName(file.slice(file.lastIndexOf('/') + 1)))
  await pooled(unique, async (file) => {
    if (sessionGone(vault, prepared.session)) throw new RefreshAbort()
    const id = noteIdFromPath(file)
    snapshot.unchangedIds.delete(id)
    const info = await fs.stat(file)
    if (sessionGone(vault, prepared.session)) throw new RefreshAbort()
    if (!info || info.kind !== 'file') {
      snapshot.diskIds.delete(id)
      return
    }
    snapshot.diskIds.add(id)
    try {
      snapshot.diskNotes.set(id, await readNoteFile(fs, file, id))
      snapshot.mtimes.set(id, info.mtimeMs)
    } catch (error) {
      if (!isUnreadableNote(error)) throw error
      if (!prepared.beforeIds.has(id)) snapshot.diskIds.delete(id)
    }
  })
  if (sessionGone(vault, prepared.session)) return null
  return snapshot
}

function assignMtimes(
  vault: VaultService,
  alive: ReadonlySet<string>,
  mtimes: ReadonlyMap<string, number>,
  dirty: ReadonlySet<string>,
) {
  const next = { ...vault.noteMtimes }
  let changed = false
  for (const id of Object.keys(next)) {
    if (!alive.has(id)) {
      delete next[id]
      changed = true
    }
  }
  for (const [id, mtime] of mtimes) {
    if (!alive.has(id) || dirty.has(id) || next[id] === mtime) continue
    next[id] = mtime
    changed = true
  }
  if (changed) vault.noteMtimes = next
}

async function applyDiskSnapshot(
  vault: VaultService,
  prepared: PreparedRefresh,
  snapshot: DiskSnapshot,
  baselineOf: () => RefreshBaseline,
): Promise<void> {
  if (sessionGone(vault, prepared.session)) return
  const previous = notesOf(vault)
  const dirty = dirtyIds(vault, prepared, baselineOf)
  const merged = mergeRefreshedNotes({
    previous,
    diskIds: snapshot.diskIds,
    diskNotes: snapshot.diskNotes,
    unchangedIds: snapshot.unchangedIds,
    dirty,
    beforeIds: prepared.beforeIds,
  })
  if (sessionGone(vault, prepared.session)) return

  const sameNotes = merged.length === previous.length && merged.every((note, index) => note === previous[index])
  if (!sameNotes) vault.notes = merged
  const alive = new Set(merged.map((note) => note.id))
  assignMtimes(vault, alive, snapshot.mtimes, dirty)

  const activeId = vault.activeId
  const beforeActive = previous.find((note) => note.id === activeId)
  const afterActive = merged.find((note) => note.id === activeId)
  if (beforeActive && afterActive && beforeActive !== afterActive) {
    const docChanged = JSON.stringify(beforeActive.doc) !== JSON.stringify(afterActive.doc)
    if (beforeActive.title !== afterActive.title || docChanged) vault.docEpoch += 1
  }

  if (snapshot.folders) {
    const { FolderService } = await import('./folder.service')
    if (has(FolderService)) {
      const folders = resolve(FolderService)
      if (!sameList(folders.folders, snapshot.folders)) folders.folders = snapshot.folders
    }
    const { FOLDER_FILTER_PREFIX } = await import('./note-identity')
    if (vault.listFilter.startsWith(FOLDER_FILTER_PREFIX)) {
      const folder = vault.listFilter.slice(FOLDER_FILTER_PREFIX.length)
      if (folder && !snapshot.folders.includes(folder)) vault.setFilter('all')
    }
  }

  const { NoteListService } = await import('../notes/note-list.service')
  if (has(NoteListService)) {
    const list = resolve(NoteListService)
    const selectedIds = list.selectedIds.filter((id) => alive.has(id))
    const anchorGone = list.anchorId !== '' && !alive.has(list.anchorId)
    if (selectedIds.length !== list.selectedIds.length || anchorGone) {
      list.selectedIds = selectedIds
      if (anchorGone) list.anchorId = selectedIds[0] ?? ''
    }
  }

  const { TabsService } = await import('../notes/tabs.service')
  if (has(TabsService)) resolve(TabsService).reconcile()
  if (vault.activeId && !alive.has(vault.activeId)) {
    vault.select(vault.visibleNotes[0]?.id ?? '')
  }

  if (vault.saveStatus !== 'error') vault.error = ''
  await reindexRefreshed(vault, previous, merged)
}

async function reindexRefreshed(
  vault: VaultService,
  previous: readonly StrideNote[],
  merged: readonly StrideNote[],
): Promise<void> {
  try {
    const previousById = new Map(previous.map((note) => [note.id, note]))
    const alive = new Set(merged.map((note) => note.id))
    const removed = previous.filter((note) => !alive.has(note.id)).map((note) => note.id)
    if (removed.length > 0) await removeIndexed(vault, removed)
    for (const note of merged) {
      const prev = previousById.get(note.id)
      if (prev === note) continue
      if (prev && indexText(prev) === indexText(note)) continue
      await upsertIndexed(vault, note)
    }
  } catch {
    console.warn('stride vault refresh: index-failed')
  }
}

async function runRefresh(
  vault: VaultService,
  baselineOf: () => RefreshBaseline,
  scan: (prepared: PreparedRefresh) => Promise<DiskSnapshot | null>,
): Promise<void> {
  const session = vault.session
  try {
    const prepared = await prepareRefresh(vault, baselineOf)
    if (!prepared) return
    const snapshot = await scan(prepared)
    if (!snapshot) return
    await applyDiskSnapshot(vault, prepared, snapshot, baselineOf)
  } catch (error) {
    if (error instanceof RefreshAbort) return
    if (vault.session !== session) return
    vault.error = errorText(error)
  }
}

/** Re-read every note and folder. Local unsaved edits are flushed first and kept. */
export function refreshVaultFromDisk(vault: VaultService, baselineOf: () => RefreshBaseline): Promise<void> {
  return enqueueVaultRefresh(() => runRefresh(vault, baselineOf, (prepared) => scanFull(vault, prepared)))
}

/**
 * Re-read the given note files. A missing parent folder reloads the folder
 * list; other directories are left untouched.
 */
export function refreshVaultPaths(
  vault: VaultService,
  paths: readonly string[],
  baselineOf: () => RefreshBaseline,
): Promise<void> {
  return enqueueVaultRefresh(() => runRefresh(vault, baselineOf, (prepared) => scanNotePaths(vault, prepared, paths)))
}

