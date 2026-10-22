import { has, raw, Service } from '@rabjs/react'
import { buildGraph, type VaultGraph } from '@stride/core/graph'
import {
  applyBody,
  applyTitle,
  isArchived,
  isPlaceholderTitle,
  noteForSave,
  parseNote,
  type NoteProperty,
  type PropertyKind,
  type StrideNote,
  type TipTapNode,
} from '@stride/core/note'
import {
  BrowserFileSystem,
  pickVaultDirectory,
  readVaultHandleById,
  restoreVaultById,
  writeVaultHandleById,
} from '@stride/fs-web'
import {
  MemoryFileSystem,
  type FileSystemBackend,
} from '@stride/platform'
import type { EmbeddingClient } from '../../../../../packages/core/src/embeddings'
import { type NoteIndex, type NoteRebuilder, type SearchHit } from '../../../../../packages/core/src/search'
import { indexText, type CacheNote, type SearchDiskCache } from '../../../../../packages/core/src/search-cache'
import type { EmbeddingRuntime, IndexSignature } from '../settings/settings.service'
import { writeSampleNotes } from '../../../../../packages/core/src/sample'
import { initializeVault } from '../../../../../packages/core/src/seed'
import { compareTypeDocuments, isTypeVisible, nextTypeOrder, templateBody } from '../../../../../packages/core/src/types'
import { rewriteVaultLinks } from '../../../../../packages/core/src/rename-tx'
import { applyViewFilter, VIEW_FILTER_PREFIX, type SavedView } from '../../../../../packages/core/src/views'
import { isDesktopRuntime, isMemoryFixture } from '../platform/runtime'
import { reportOpenProject, syncRecentProjects } from '../platform/windows'
import {
  mergeVaultRecords,
  parseVaultRecords,
  readStoredVaults,
  reconcileRegistry,
  recentProjectsFromRecords,
  VAULT_REGISTRY_KEY,
  type RecentProject,
} from './vault-registry'
import {
  sanitizeGitSetupPreference,
  sanitizeViewMode,
  sanitizeZoom,
  writeAdvanceInbox,
  writeAgentMode,
  writeGitSetupPreference,
  writeRenameFromHeading,
  writeViewMode,
  writeZoom,
  type GitSetupPreference,
  type ViewMode,
} from '../../../../../packages/core/src/vault-config'
import {
  createVaultNote,
  listNoteFiles,
  nextSlugId,
  noteIdFromPath,
  notePath,
  readNoteFile,
  saveNote,
} from '../../../../../packages/core/src/vault'
import { ListFilterService } from '../search/list-filter.service'
import { applyStageZoom } from '../layout/stage-zoom'
import { ViewsService } from '../views/views.service'
import { applyNoteIdChanges, FOLDER_FILTER_PREFIX } from './note-identity'
import * as vaultOpen from './vault-open'
import * as propertyEditor from './vault-properties'
import * as searchSession from './vault-search-session'

export { FOLDER_FILTER_PREFIX }
export { embeddingClient, searchSlot } from './vault-search-session'

const COLLAPSED_TYPES_KEY = 'stride:collapsed-types'

const UNCONFIGURED_EMBEDDING: EmbeddingRuntime = {
  endpoint: '',
  model: '',
  apiKey: '',
  dim: 0,
  intended: false,
  active: false,
}

// The browser has no home directory. openVault only uses this to reject broad personal roots.
const HOME_DIR = '/Users/stride'

export { VAULT_REGISTRY_KEY }

export interface VaultRecord {
  id: string
  label: string
  color: string
  icon: string
  lastOpened: string
}

// Dev-only: `?fixture=memory&seed=N` programmatically fills the in-memory vault
// with N notes for performance testing. Compile-time gated so the generator is
// dead-code-eliminated from production builds.
function memoryFixtureSeedCount(): number {
  try {
    if (!import.meta.env.DEV) return 0
    const raw = new URLSearchParams(window.location.search).get('seed')
    const count = Number(raw)
    if (!Number.isFinite(count) || count <= 0) return 0
    return Math.min(Math.floor(count), 50_000)
  } catch {
    return 0
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isTypeDocument(note: StrideNote): boolean {
  return note.type === 'Type'
}

function readCollapsedTypes(): string[] {
  try {
    if (typeof localStorage === 'undefined') return []
    const raw = localStorage.getItem(COLLAPSED_TYPES_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is string => typeof item === 'string')
  } catch {
    return []
  }
}

function writeCollapsedTypes(titles: string[]) {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(COLLAPSED_TYPES_KEY, JSON.stringify(titles))
  } catch {
    return
  }
}

// Cross-render derivation caches, keyed by the raw notes array. VaultService
// replaces `notes` immutably on every mutation, so array identity is a
// complete change signal and WeakMap entries die with the array. Computing
// over raw notes keeps 10k-note scans off the reactive tracking bus — at
// fixture scale, per-key reaction registration (not the scan itself)
// dominated CPU profiles of vault open.
const graphCache = new WeakMap<StrideNote[], VaultGraph>()
const typeDocCache = new WeakMap<StrideNote[], StrideNote[]>()
const listedCache = new WeakMap<StrideNote[], StrideNote[]>()
const visibleCache = new WeakMap<
  StrideNote[],
  { hits: { id: string; score: number }[]; query: string; filter: string; view: SavedView | null; result: StrideNote[] }
>()

function createVaultId(): string {
  const randomUUID = globalThis.crypto?.randomUUID
  if (typeof randomUUID === 'function') return randomUUID.call(globalThis.crypto)
  return `vault-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

async function sameDirectory(left: FileSystemDirectoryHandle, right: FileSystemDirectoryHandle): Promise<boolean> {
  if (left === right) return true
  if (typeof left.isSameEntry !== 'function') return false
  return left.isSameEntry(right)
}

export async function pickVaultBackend(): Promise<FileSystemBackend> {
  if (!isDesktopRuntime()) return pickVaultDirectory()
  const dialog = await import('@tauri-apps/plugin-dialog')
  const selected = await dialog.open({ directory: true, multiple: false })
  if (typeof selected !== 'string' || selected === '') {
    throw new Error('The user aborted a request.')
  }
  const { TauriFileSystem } = await import('@stride/fs-tauri')
  return new TauriFileSystem(selected)
}

export class VaultService extends Service {
  phase: 'chooser' | 'ready' = 'chooser'
  vaultPath = ''
  openedClonePath = ''
  pathDraft = ''
  broad = false
  notes: StrideNote[] = []
  activeId = ''
  listFilter = 'all'
  error = ''
  saveStatus: 'idle' | 'pending' | 'saving' | 'saved' | 'error' = 'idle'
  searchQuery = ''
  searchHits: { id: string; score: number }[] = []
  searchMode = ''
  searchDegraded = false
  indexPhase: 'idle' | 'rebuilding' | 'ready' | 'error' = 'idle'
  indexWork: 'idle' | 'indexing' | 'embedding' = 'idle'
  indexDone = 0
  indexTotal = 0
  docEpoch = 0
  renameFromHeading = true
  agentMode: 'safe' | 'power' = 'safe'
  advanceInbox = true
  // Per-vault settings (T7.3), all persisted in .stride/vault.json.
  zoom = 1
  viewMode: ViewMode = 'comfortable'
  gitSetupPreference: GitSetupPreference = 'undecided'
  propertyName = ''
  propertyType: PropertyKind = 'string'
  propertyValue = ''
  propertyChecked = false
  collapsedTypes: string[] = readCollapsedTypes()
  fs: FileSystemBackend | null = null
  vaults: VaultRecord[] = []
  activeVaultId = ''
  // File mtimes keyed by note id. Derived for the note list's relative dates.
  noteMtimes: Record<string, number> = {}
  // Signature passed to the last successful opener.open. Save compares against this.
  indexSignature: IndexSignature = { endpoint: '', model: '', dim: 0, active: false }
  index: NoteIndex | null = null
  rebuilder: NoteRebuilder | null = null
  rebuildEpoch = 0
  rebuildDone: Promise<void> = Promise.resolve()
  private openQueue: Promise<void> = Promise.resolve()
  private docTimer: ReturnType<typeof setTimeout> | null = null
  /** In-flight autosave. Fake timers do not wait for the timer callback's promise. */
  private saveTask: Promise<void> = Promise.resolve()
  // Autosave debounce (ms). Settings > Editor pushes the configured value via
  // setAutosaveDebounceMs; schedule() also re-syncs it lazily from
  // SettingsService so a value persisted in a previous session applies even
  // when the settings page was never opened.
  private autosaveDebounceMs = 350
  pendingId = ''
  private retryDelay = 1000
  private renaming = false
  private titleBaseline = new Map<string, string>()
  private leaveQueue: StrideNote[] = []
  numberDrafts: Record<string, string> = {}
  listDrafts: Record<string, string> = {}
  private saveGeneration = 0
  private saveChain: Promise<void> = Promise.resolve()
  private registryReady = false
  private registryListening = false
  private memoryRoot: MemoryFileSystem | null = null
  private readonly backends = new Map<string, FileSystemBackend>()
  private readonly idsByBackend = new Map<FileSystemBackend, string>()

  setPathDraft(value: string) {
    this.pathDraft = value
  }

  setFilter(filter: string) {
    this.listFilter = filter
  }

  select(id: string) {
    if (id === this.activeId) return
    const leaving = this.active
    void this.commitHeadingRename(leaving)
    this.activeId = id
    this.resetPropertyEditor()
  }

  get active(): StrideNote | null {
    return this.notes.find((note) => note.id === this.activeId) ?? null
  }

  get graph(): VaultGraph {
    const notes = this.notes // tracked read: identity changes on every mutation
    const key = raw(notes)
    let graph = graphCache.get(key)
    if (!graph) {
      graph = buildGraph(key)
      graphCache.set(key, graph)
    }
    return graph
  }

  get typeDocuments(): StrideNote[] {
    const notes = this.notes // tracked read
    const key = raw(notes)
    let docs = typeDocCache.get(key)
    if (!docs) {
      docs = key.filter((note) => isTypeDocument(note)).sort(compareTypeDocuments)
      typeDocCache.set(key, docs)
    }
    return docs
  }

  get sidebarTypes(): StrideNote[] {
    return this.typeDocuments.filter((note) => isTypeVisible(note))
  }

  get typeInstances(): StrideNote[] {
    const active = this.active
    if (!active || !isTypeDocument(active)) return []
    return this.notes.filter((note) => note.id !== active.id && note.type === active.title && !isArchived(note))
  }

  toggleTypeCollapsed(title: string) {
    const next = this.collapsedTypes.includes(title)
      ? this.collapsedTypes.filter((item) => item !== title)
      : [...this.collapsedTypes, title]
    this.collapsedTypes = next
    writeCollapsedTypes(next)
  }

  get inboxCount(): number {
    return this.graph.inbox.filter((note) => !isTypeDocument(note) && !isArchived(note)).length
  }

  /**
   * Every listable note (type docs and archived excluded), ignoring all filter
   * dimensions. The folder tree renders from this while a folder scope is
   * active — selecting a folder narrows the note-list column, never the tree.
   */
  get listedNotes(): StrideNote[] {
    const key = raw(this.notes)
    let result = listedCache.get(key)
    if (!result) {
      result = key.filter((note) => !isTypeDocument(note) && !isArchived(note))
      listedCache.set(key, result)
    }
    return result
  }

  get currentVaultLabel(): string {
    const entry = this.vaults.find((item) => item.id === this.activeVaultId)
    return entry?.label || this.fs?.rootLabel || ''
  }

  get recentVaults(): VaultRecord[] {
    this.ensureRegistry()
    return [...this.vaults].sort((left, right) => right.lastOpened.localeCompare(left.lastOpened))
  }

  get visibleNotes(): StrideNote[] {
    // Tracked reads: every input of the derivation. Arrays are replaced
    // immutably, so identity captures hits changes; the rest are primitives.
    const hits = this.searchHits
    const query = this.searchQuery
    const filter = this.listFilter
    // A saved view joins the cache key by raw identity: ViewsService replaces
    // view objects on every reload, so an edited view invalidates the cache,
    // and raw() keeps the key stable across per-access proxies.
    const resolved = filter.startsWith(VIEW_FILTER_PREFIX)
      ? this.viewsService?.byFile(filter.slice(VIEW_FILTER_PREFIX.length))?.view ?? null
      : null
    const view = resolved ? raw(resolved) : null
    const key = raw(this.notes)
    const cached = visibleCache.get(key)
    if (cached && cached.hits === raw(hits) && cached.query === query && cached.filter === filter && cached.view === view) {
      return cached.result
    }
    const listed = (notes: readonly StrideNote[]) => notes.filter((note) => !isTypeDocument(note) && !isArchived(note))
    let result: StrideNote[]
    if (hits.length && query.trim()) {
      const ids = new Set(hits.map((hit) => hit.id))
      result = listed(key.filter((note) => ids.has(note.id)))
    } else if (filter === 'inbox') {
      result = listed(this.graph.inbox)
    } else if (view) {
      // Saved view: its own base (Type docs always out; archived only when the
      // view opts in), then the view's type/property conditions.
      result = applyViewFilter(key, view)
    } else if (filter.startsWith(FOLDER_FILTER_PREFIX)) {
      // Folder dimension: the folder's subtree — direct and nested notes alike.
      const prefix = `${filter.slice(FOLDER_FILTER_PREFIX.length)}/`
      result = listed(key.filter((note) => note.id.startsWith(prefix)))
    } else if (filter !== 'all' && !filter.startsWith(VIEW_FILTER_PREFIX)) {
      result = listed(this.graph.byType.get(filter) ?? [])
    } else {
      result = listed(key)
    }
    visibleCache.set(key, { hits: raw(hits), query, filter, view, result })
    return result
  }

  async openVaultPath(path: string) {
    if (!isDesktopRuntime()) return
    this.error = ''
    try {
      await this.commitHeadingRename()
      const { TauriFileSystem } = await import('@stride/fs-tauri')
      await this.openBackend(new TauriFileSystem(path))
    } catch (error) {
      this.error = errorText(error)
    }
  }

  async restoreOpened() {
    if (isMemoryFixture()) return
    this.ensureRegistry()
    const last = this.latestRecord()
    if (!last) return
    try {
      if (isDesktopRuntime()) {
        const { TauriFileSystem } = await import('@stride/fs-tauri')
        await this.openBackend(new TauriFileSystem(last.label))
        return
      }
      const restored = await restoreVaultById(last.id)
      if (!restored) return
      await this.openBackend(restored)
    } catch (error) {
      this.error = errorText(error)
    }
  }

  async openFromDraft() {
    this.error = ''
    try {
      const backend = isMemoryFixture() ? this.memoryFixtureRoot() : await pickVaultBackend()
      await this.seedMemoryFixture(backend)
      await this.openBackend(backend)
    } catch (error) {
      this.error = errorText(error)
    }
  }

  async createNewVault() {
    this.error = ''
    try {
      const backend = isMemoryFixture()
        ? new MemoryFileSystem('memory-vault')
        : await pickVaultBackend()
      await initializeVault(backend, HOME_DIR)
      await this.openBackend(backend)
    } catch (error) {
      this.error = errorText(error)
    }
  }

  async cloneSampleVault() {
    this.error = ''
    try {
      const backend = isMemoryFixture()
        ? new MemoryFileSystem('memory-vault')
        : await pickVaultBackend()
      await initializeVault(backend, HOME_DIR)
      await writeSampleNotes(backend)
      await this.openBackend(backend)
    } catch (error) {
      this.error = errorText(error)
    }
  }

  upsertVault(entry: VaultRecord) {
    if (!entry.id) return
    this.ensureRegistry()
    const index = this.vaults.findIndex((item) => item.id === entry.id)
    if (index === -1) {
      this.vaults = [...this.vaults, entry]
    } else {
      const next = this.vaults.slice()
      next[index] = { ...next[index], ...entry }
      this.vaults = next
    }
    this.persistRegistry()
  }

  async switchVault(id: string) {
    this.ensureRegistry()
    const entry = this.vaults.find((item) => item.id === id)
    if (!entry) {
      this.error = 'That vault is not in the registry.'
      return
    }
    if (id === this.activeVaultId && this.phase === 'ready' && this.fs) return
    const cached = this.backends.get(id)
    if (cached) {
      try {
        await this.commitHeadingRename()
        await this.openBackend(cached)
        this.error = ''
      } catch (error) {
        this.error = errorText(error)
      }
      return
    }
    if (isMemoryFixture()) {
      this.error = 'That vault is not available.'
      return
    }
    if (isDesktopRuntime()) {
      try {
        const { TauriFileSystem } = await import('@stride/fs-tauri')
        await this.commitHeadingRename()
        await this.openBackend(new TauriFileSystem(entry.label))
        this.error = ''
      } catch (error) {
        this.error = errorText(error)
      }
      return
    }
    try {
      const restored = await restoreVaultById(id)
      if (!restored) {
        this.error = 'The directory handle for this vault is missing.'
        return
      }
      await this.commitHeadingRename()
      await this.openBackend(restored)
      this.error = ''
    } catch (error) {
      this.error = errorText(error)
    }
  }

  async showChooser() {
    if (this.phase === 'chooser') return
    this.error = ''
    await this.commitHeadingRename()
    this.phase = 'chooser'
    reportOpenProject(null)
    const { SettingsService } = await import('../settings/settings.service')
    if (has(SettingsService)) await this.resolve(SettingsService).bindUsageVault(null)
  }

  async createNote() {
    this.error = ''
    try {
      if (!this.fs) throw new Error('Open a vault first')
      const note = await createVaultNote(this.fs, 'Untitled')
      this.notes = [note, ...this.notes.filter((item) => item.id !== note.id)]
      this.activeId = note.id
      this.listFilter = 'all'
      this.searchHits = []
      this.searchQuery = ''
      await this.upsertIndexed(note)
    } catch (error) {
      this.error = errorText(error)
    }
  }

  // Born with `title`. createNote() writes Untitled and switches notes first.
  async createLinkedNote(title: string) {
    this.error = ''
    if (!title.trim()) return
    try {
      if (!this.fs) throw new Error('Open a vault first')
      const note = await createVaultNote(this.fs, title)
      this.notes = [note, ...this.notes.filter((item) => item.id !== note.id)]
      await this.upsertIndexed(note)
      this.select(note.id)
    } catch (error) {
      this.error = errorText(error)
    }
  }

  async createType() {
    this.error = ''
    try {
      if (!this.fs) throw new Error('Open a vault first')
      const created = await createVaultNote(this.fs, 'Untitled')
      const note = noteForSave({
        ...created,
        type: 'Type',
        properties: {
          _icon: 'note',
          _color: 'gray',
          visible: 'true',
          _order: nextTypeOrder(this.notes),
        },
      })
      const saved = await saveNote(this.fs, note)
      this.notes = [saved, ...this.notes.filter((item) => item.id !== saved.id)]
      this.activeId = saved.id
      this.searchHits = []
      this.searchQuery = ''
      await this.upsertIndexed(saved)
    } catch (error) {
      this.error = errorText(error)
    }
  }

  async createInstance(typeTitle: string) {
    this.error = ''
    try {
      if (!this.fs) throw new Error('Open a vault first')
      const typeDoc = this.notes.find((item) => isTypeDocument(item) && item.title === typeTitle)
      const created = await createVaultNote(this.fs, 'Untitled')
      const body = templateBody(typeDoc?.properties.template)
      const note = noteForSave({
        ...created,
        type: typeTitle,
        doc: body ?? created.doc,
      })
      const saved = await saveNote(this.fs, note)
      this.notes = [saved, ...this.notes.filter((item) => item.id !== saved.id)]
      this.activeId = saved.id
      this.listFilter = typeTitle
      this.searchHits = []
      this.searchQuery = ''
      await this.upsertIndexed(saved)
    } catch (error) {
      this.error = errorText(error)
    }
  }

  updateDoc(body: TipTapNode) {
    const current = this.active
    if (!current) return
    const next = applyBody(current.title, body)
    if (next.title !== current.title && !this.titleBaseline.has(current.id)) {
      this.titleBaseline.set(current.id, current.title)
    }
    this.replace({ ...current, title: next.title, doc: next.doc })
    if (next.lifted) this.docEpoch += 1
    this.schedule(current.id)
  }

  updateTitle(title: string) {
    const current = this.active
    if (!current) return
    if (!this.titleBaseline.has(current.id)) this.titleBaseline.set(current.id, current.title)
    this.replace({ ...current, title, doc: applyTitle(current.doc, title) })
    this.schedule(current.id)
  }

  async setRenameFromHeading(enabled: boolean) {
    this.renameFromHeading = enabled
    if (!this.fs) return
    try {
      await writeRenameFromHeading(this.fs, enabled)
    } catch (error) {
      this.error = errorText(error)
    }
  }

  /** Settings > Editor pushes the autosave debounce here; the next edit's timer uses it. */
  setAutosaveDebounceMs(value: number) {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      this.autosaveDebounceMs = value
    }
  }

  async setAdvanceInbox(enabled: boolean) {
    this.advanceInbox = enabled
    if (!this.fs) return
    try {
      await writeAdvanceInbox(this.fs, enabled)
    } catch (error) {
      this.error = errorText(error)
    }
  }

  async setAgentMode(mode: 'safe' | 'power') {
    this.agentMode = mode
    if (!this.fs) return
    try {
      await writeAgentMode(this.fs, mode)
    } catch (error) {
      this.error = errorText(error)
    }
  }

  /** Per-vault editor zoom (T7.3). Illegal values fall back to 1; applies to the stage immediately. */
  async setZoom(value: number) {
    const zoom = sanitizeZoom(value)
    this.zoom = zoom
    applyStageZoom(zoom)
    if (!this.fs) return
    try {
      await writeZoom(this.fs, zoom)
    } catch (error) {
      this.error = errorText(error)
    }
  }

  /** Per-vault note-list density (T7.3); NoteList renders from this field. */
  async setViewMode(mode: ViewMode) {
    this.viewMode = sanitizeViewMode(mode)
    if (!this.fs) return
    try {
      await writeViewMode(this.fs, this.viewMode)
    } catch (error) {
      this.error = errorText(error)
    }
  }

  /** Per-vault git setup intent (T7.3). Stored and shown only; git behavior is unchanged. */
  async setGitSetupPreference(preference: GitSetupPreference) {
    this.gitSetupPreference = sanitizeGitSetupPreference(preference)
    if (!this.fs) return
    try {
      await writeGitSetupPreference(this.fs, this.gitSetupPreference)
    } catch (error) {
      this.error = errorText(error)
    }
  }

  retargetTitleBaseline(fromId: string, toId: string) {
    if (fromId === toId || !this.titleBaseline.has(fromId)) return
    const previous = this.titleBaseline.get(fromId)
    this.titleBaseline.delete(fromId)
    if (previous !== undefined) this.titleBaseline.set(toId, previous)
  }

  // Folder rename and note moves change ids. Drop the old id and index the note at the new one.
  async syncMovedIds(changes: { fromId: string; toId: string }[]): Promise<void> {
    const moved = changes.filter((change) => change.fromId !== change.toId)
    if (moved.length === 0) return
    for (const change of moved) {
      if (this.pendingId === change.fromId) this.pendingId = change.toId
    }
    await this.removeIndexed(moved.map((change) => change.fromId))
    const remapped = { ...this.noteMtimes }
    for (const change of moved) {
      if (change.fromId in remapped) {
        remapped[change.toId] = remapped[change.fromId]!
        delete remapped[change.fromId]
      }
    }
    this.noteMtimes = remapped
    const docs = []
    for (const change of moved) {
      const note = this.notes.find((item) => item.id === change.toId)
      if (note) docs.push({ id: note.id, text: indexText(note) })
    }
    if (!this.rebuilder || docs.length === 0) return
    const prepared = await this.prepareIndexed(docs, () => true, 'upsert')
    if (!prepared) return
    await this.rebuilder.upsert(prepared)
  }

  async commitHeadingRename(explicit?: StrideNote | null) {
    const leaving = explicit === undefined ? this.active : explicit
    const fs = this.fs
    if (!leaving || !fs) return
    if (this.renaming) {
      this.leaveQueue.push(leaving)
      return
    }
    const fromId = leaving.id
    this.renaming = true
    try {
      let diskTitle = ''
      try {
        diskTitle = (await readNoteFile(fs, notePath(fromId))).title
      } catch {
        diskTitle = ''
      }
      await this.flush()
      if (!this.renameFromHeading) return
      const fresh = this.notes.find((note) => note.id === fromId)
      if (!fresh || isPlaceholderTitle(fresh.title)) return
      const previous = this.titleBaseline.get(fromId) ?? diskTitle
      let nextId: string | undefined
      if (previous && !isPlaceholderTitle(previous) && previous !== fresh.title) {
        nextId = await nextSlugId(fs, fresh.title, fresh.id)
        await rewriteVaultLinks(fs, { fromTitle: previous, toTitle: fresh.title, fromId, toId: nextId })
        const files = await listNoteFiles(fs)
        const disk = new Map<string, StrideNote>()
        for (const file of files) {
          const note = await readNoteFile(fs, file, noteIdFromPath(file))
          disk.set(note.id, note)
        }
        this.notes = this.notes.map((note) => disk.get(note.id) ?? note)
        this.docEpoch += 1
      }
      if (nextId === undefined) nextId = await nextSlugId(fs, fresh.title, fresh.id)
      if (nextId !== fresh.id) {
        await fs.rename(notePath(fromId), notePath(nextId))
        await applyNoteIdChanges(this, [{ fromId, toId: nextId }])
      }
      this.titleBaseline.delete(fromId)
      this.titleBaseline.delete(nextId)
    } catch (error) {
      this.error = errorText(error)
    } finally {
      this.renaming = false
      const next = this.leaveQueue.shift()
      if (next) await this.commitHeadingRename(next)
    }
  }

  updateType(type: string) {
    const current = this.active
    if (!current) return
    this.replace({ ...current, type })
    this.schedule(current.id)
  }

  setPropertyName(value: string) {
    return propertyEditor.setPropertyName(this, value)
  }

  setPropertyType(value: string) {
    return propertyEditor.setPropertyType(this, value)
  }

  setPropertyValue(value: string) {
    return propertyEditor.setPropertyValue(this, value)
  }

  setPropertyChecked(value: boolean) {
    return propertyEditor.setPropertyChecked(this, value)
  }

  addProperty() {
    return propertyEditor.addProperty(this)
  }

  updateProperty(field: string, raw: string) {
    return propertyEditor.updateProperty(this, field, raw)
  }

  updateListProperty(field: string, raw: string) {
    return propertyEditor.updateListProperty(this, field, raw)
  }

  updateNumberProperty(field: string, raw: string) {
    return propertyEditor.updateNumberProperty(this, field, raw)
  }

  updateBooleanProperty(field: string, value: boolean) {
    return propertyEditor.updateBooleanProperty(this, field, value)
  }

  removeProperty(field: string) {
    return propertyEditor.removeProperty(this, field)
  }

  commitListProperty(field: string) {
    return propertyEditor.commitListProperty(this, field)
  }

  commitNumberProperty(field: string) {
    return propertyEditor.commitNumberProperty(this, field)
  }

  blurProperty() {
    return propertyEditor.blurProperty(this)
  }

  numberText(field: string): string {
    return propertyEditor.numberText(this, field)
  }

  listText(field: string): string {
    return propertyEditor.listText(this, field)
  }

  propertyText(field: string): string {
    return propertyEditor.propertyText(this, field)
  }

  async runSearch() {
    return searchSession.runSearch(this)
  }

  // Title weighting stays in rankSearch. Hybrid is only the BM25/vector hit list.
  async queryRanked(text: string) {
    return searchSession.queryRanked(this, text)
  }

  clearSearch() {
    this.searchQuery = ''
    this.searchHits = []
    this.searchMode = ''
  }

  adopt(notes: StrideNote[]) {
    this.cancelPending()
    this.notes = notes
    this.docEpoch += 1
    this.resetPropertyEditor()
    if (!notes.some((note) => note.id === this.activeId)) {
      this.activeId = notes[0]?.id ?? ''
    }
  }

  cancelPending() {
    if (this.docTimer) clearTimeout(this.docTimer)
    this.docTimer = null
    this.pendingId = ''
    this.retryDelay = 1000
    this.saveStatus = 'idle'
  }

  // File writes share one chain so a debounced save cannot land after a restore.
  private enqueueWrite(job: () => Promise<void>): Promise<void> {
    const run = this.saveChain.then(job, job)
    this.saveChain = run.then(() => undefined, () => undefined)
    return run
  }

  async restoreActiveNote(raw: string): Promise<void> {
    const id = this.activeId
    const fs = this.fs
    if (!id || !fs) throw new Error('No active note')
    const note = parseNote(raw, id)
    const path = notePath(id)
    this.cancelPending()
    this.saveGeneration += 1
    await this.enqueueWrite(async () => {
      await fs.writeText(path, raw)
    })
    if (this.notes.some((item) => item.id === note.id)) this.replace(note)
    else this.notes = [note, ...this.notes]
    this.docEpoch += 1
    await this.upsertIndexed(note)
  }

  async flush(): Promise<void> {
    if (this.docTimer) {
      clearTimeout(this.docTimer)
      this.docTimer = null
    }
    if (!this.pendingId) return
    const id = this.pendingId
    const generation = this.saveGeneration
    const note = this.notes.find((item) => item.id === id)
    if (!note || !this.fs) {
      this.pendingId = ''
      this.saveStatus = 'idle'
      return
    }
    const fs = this.fs
    this.saveStatus = 'saving'
    await this.enqueueWrite(async () => {
      if (generation !== this.saveGeneration) {
        if (this.pendingId) this.saveStatus = 'pending'
        else if (this.saveStatus === 'saving') this.saveStatus = 'idle'
        return
      }
      let saved: StrideNote
      try {
        saved = await saveNote(fs, noteForSave(note))
      } catch (error) {
        this.error = errorText(error)
        if (generation !== this.saveGeneration) {
          this.saveStatus = this.pendingId ? 'pending' : 'error'
          return
        }
        this.pendingId = id
        this.saveStatus = 'error'
        const delay = this.retryDelay
        this.docTimer = setTimeout(() => {
          void this.flush()
        }, delay)
        this.retryDelay = Math.min(delay * 2, 8000)
        return
      }
      // A newer edit landed while the file write was in flight.
      if (generation !== this.saveGeneration) {
        if (this.pendingId) this.saveStatus = 'pending'
        else if (this.saveStatus === 'saving') this.saveStatus = 'idle'
        return
      }
      this.pendingId = ''
      this.retryDelay = 1000
      this.saveStatus = 'saved'
      this.error = ''
      this.replace(saved)
      this.noteMtimes = { ...this.noteMtimes, [saved.id]: Date.now() }
      await this.upsertIndexed(saved)
    })
  }

  get listFilterService() {
    return this.resolve(ListFilterService)
  }

  // Saved views are optional: tests that never import views.service leave it unregistered.
  private get viewsService(): ViewsService | null {
    return has(ViewsService) ? this.resolve(ViewsService) : null
  }

  openClonedVault(backend: FileSystemBackend): Promise<void> {
    this.openedClonePath = backend.rootLabel
    return this.openBackend(backend)
  }

  private openBackend(backend: FileSystemBackend): Promise<void> {
    const run = this.openQueue.catch(() => undefined).then(() => this.openBackendBody(backend))
    this.openQueue = run.then(() => undefined, () => undefined)
    return run
  }

  // Settings save reopens the current directory. It does not prompt and stays on openQueue.
  reopenForSettings(): Promise<void> {
    const backend = this.fs
    if (!backend || this.phase !== 'ready') return Promise.resolve()
    return this.openBackend(backend)
  }

  private openBackendBody(backend: FileSystemBackend) {
    return vaultOpen.openBackendBody(this, backend)
  }

  // Best-effort mtime harvest for the note list. Never blocks or fails an open.
  // Guard on the open epoch only: `this.fs` reads back as a reactive proxy, so
  // comparing it against the raw backend reference would always mismatch.
  async refreshMtimes(epoch: number, notes: StrideNote[]) {
    const fs = this.fs
    if (!fs) return
    const entries = await Promise.all(
      notes.map(async (note) => {
        try {
          const stat = await fs.stat(notePath(note.id))
          return [note.id, stat?.mtimeMs ?? 0] as const
        } catch {
          return [note.id, 0] as const
        }
      }),
    )
    if (epoch !== this.rebuildEpoch) return
    const mtimes: Record<string, number> = {}
    for (const [id, mtime] of entries) {
      if (mtime > 0) mtimes[id] = mtime
    }
    this.noteMtimes = mtimes
  }

  private startRebuild(epoch: number, docs: { id: string; text: string }[]): Promise<void> {
    return searchSession.startRebuild(this, epoch, docs)
  }

  // Status bar retry entry after a failed index rebuild. Pure presentation
  // support: re-runs the same rebuild pipeline against the current notes.
  retryIndex() {
    return searchSession.retryIndex(this)
  }

  retryMisses() {
    return searchSession.retryMisses(this)
  }

  private memoryFixtureRoot(): MemoryFileSystem {
    this.memoryRoot ??= new MemoryFileSystem('memory-vault')
    return this.memoryRoot
  }

  // Dev-only perf fixture: fill a fresh memory vault with N generated notes.
  // Skips when the vault already holds enough notes (a reopened fixture vault).
  // The DEV gate is compile-time: production builds drop the dynamic import.
  private async seedMemoryFixture(backend: FileSystemBackend) {
    if (!import.meta.env.DEV) return
    if (!(backend instanceof MemoryFileSystem)) return
    const count = memoryFixtureSeedCount()
    if (count === 0) return
    const existing = await listNoteFiles(backend)
    if (existing.length >= count) return
    const started = performance.now()
    const { writeFixtureNotes } = await import('../../dev/fixture-notes')
    await writeFixtureNotes(backend, count)
    console.info(`[fixture] seeded ${count} notes in ${(performance.now() - started).toFixed(0)}ms`)
  }

  private ensureRegistry() {
    if (!this.registryReady) {
      this.registryReady = true
      if (!isMemoryFixture() && typeof localStorage !== 'undefined') {
        this.vaults = parseVaultRecords(localStorage.getItem(VAULT_REGISTRY_KEY))
      }
    }
    this.ensureRegistryListener()
  }

  private ensureRegistryListener() {
    if (this.registryListening || typeof window === 'undefined') return
    this.registryListening = true
    window.addEventListener('storage', this.onRegistryStorage)
  }

  private onRegistryStorage = (event: StorageEvent) => {
    if (isMemoryFixture() || event.key !== VAULT_REGISTRY_KEY) return
    const next = reconcileRegistry(this.vaults, parseVaultRecords(event.newValue))
    const active = this.vaults.find((entry) => entry.id === this.activeVaultId)
    if (active && !next.some((entry) => entry.id === active.id)) {
      this.writeRegistry([...next, active], 'merge')
      return
    }
    this.vaults = next
  }

  private persistRegistry() {
    this.writeRegistry(this.vaults, 'merge')
  }

  private writeRegistry(records: readonly VaultRecord[], mode: 'merge' | 'replace') {
    if (isMemoryFixture()) return
    if (typeof localStorage === 'undefined') return
    const next = mode === 'merge' ? mergeVaultRecords(records, readStoredVaults()) : [...records]
    this.vaults = next
    localStorage.setItem(VAULT_REGISTRY_KEY, JSON.stringify(next))
    if (mode === 'merge') syncRecentProjects(recentProjectsFromRecords(next))
  }

  replaceRecentProjects(projects: readonly RecentProject[]) {
    if (isMemoryFixture()) return
    this.ensureRegistry()
    const next = projects.map((project) => {
      const previous = this.vaults.find((entry) => entry.id === project.id || entry.label === project.path)
      return {
        id: previous?.id ?? project.id,
        label: project.path,
        color: previous?.color ?? '',
        icon: previous?.icon ?? '',
        lastOpened: previous && previous.lastOpened > project.lastOpened ? previous.lastOpened : project.lastOpened,
      }
    })
    const active = this.vaults.find((entry) => entry.id === this.activeVaultId)
    if (active && !next.some((entry) => entry.id === active.id)) next.push(active)
    this.writeRegistry(next, 'replace')
  }

  private latestRecord(): VaultRecord | null {
    let latest: VaultRecord | null = null
    for (const entry of this.vaults) {
      if (!latest || entry.lastOpened >= latest.lastOpened) latest = entry
    }
    return latest
  }

  private openedStamp(): string {
    let stamp = new Date().toISOString()
    for (const entry of this.vaults) {
      if (stamp > entry.lastOpened) continue
      const parsed = Date.parse(entry.lastOpened)
      stamp = new Date((Number.isFinite(parsed) ? parsed : Date.now()) + 1).toISOString()
    }
    return stamp
  }

  async rememberVault(backend: FileSystemBackend) {
    this.ensureRegistry()
    const id = await this.idFor(backend)
    const previous = this.vaults.find((entry) => entry.id === id)
    this.upsertVault({
      id,
      label: backend.rootLabel,
      color: previous?.color ?? '',
      icon: previous?.icon ?? '',
      lastOpened: this.openedStamp(),
    })
    this.backends.set(id, backend)
    this.idsByBackend.set(backend, id)
    this.activeVaultId = id
    reportOpenProject(backend.rootLabel)
    if (isMemoryFixture() || !(backend instanceof BrowserFileSystem)) return
    await writeVaultHandleById(id, backend.directoryHandle)
  }

  private async idFor(backend: FileSystemBackend): Promise<string> {
    const known = this.idsByBackend.get(backend)
    if (known) return known
    if (backend instanceof BrowserFileSystem) {
      const handle = backend.directoryHandle
      for (const entry of this.vaults) {
        const cached = this.backends.get(entry.id)
        if (cached instanceof BrowserFileSystem) {
          if (await sameDirectory(cached.directoryHandle, handle)) return entry.id
          continue
        }
        const stored = await readVaultHandleById(entry.id)
        if (stored && await sameDirectory(stored, handle)) return entry.id
      }
    } else if (isDesktopRuntime()) {
      const existing = this.vaults.find((entry) => {
        const cached = this.backends.get(entry.id)
        if (cached) return cached.rootLabel === backend.rootLabel
        return entry.label === backend.rootLabel
      })
      if (existing) return existing.id
    }
    return createVaultId()
  }

  private openSearchSession(vaultKey: string, dim: number) {
    return searchSession.openSearchSession(this, vaultKey, dim)
  }

  private async upsertIndexed(note: StrideNote) {
    return searchSession.upsertIndexed(this, note)
  }

  async currentEmbedding(): Promise<EmbeddingRuntime> {
    const { SettingsService } = await import('../settings/settings.service')
    if (!has(SettingsService)) return UNCONFIGURED_EMBEDDING
    const settings = this.resolve(SettingsService)
    await settings.waitUntilLoaded()
    return settings.embeddingRuntime()
  }

  private async rankedHits(text: string, topK: number): Promise<SearchHit[]> {
    return searchSession.rankedHits(this, text, topK)
  }

  // Embed failures omit the vector so search-web stores zeros. Cache misses stay out of SEMB.
  private async prepareIndexed(
    docs: { id: string; text: string }[],
    shouldContinue: () => boolean,
    mode: 'rebuild' | 'upsert',
  ): Promise<{ id: string; text: string; vector?: number[] }[] | null> {
    return searchSession.prepareIndexed(this, docs, shouldContinue, mode)
  }

  private async embedMisses(epoch: number) {
    return searchSession.embedMisses(this, epoch)
  }

  private retainNotes(disk: SearchDiskCache, notes: readonly CacheNote[]) {
    return searchSession.retainNotes(this, disk, notes)
  }

  private async embedGroups(
    embedNotes: readonly CacheNote[],
    runtime: EmbeddingRuntime,
    shouldContinue: () => boolean,
    disk: SearchDiskCache | null,
  ): Promise<Map<string, number[]> | null> {
    return searchSession.embedGroups(this, embedNotes, runtime, shouldContinue, disk)
  }

  private embeddingSettings(runtime: EmbeddingRuntime) {
    return searchSession.embeddingSettings(this, runtime)
  }

  private vectorGapFor(runtime: EmbeddingRuntime): number {
    return searchSession.vectorGapFor(this, runtime)
  }

  private publishGap(runtime: EmbeddingRuntime, work: 'sync' | 'keep', queryDegraded = false) {
    return searchSession.publishGap(this, runtime, work, queryDegraded)
  }

  private queryEmbeddingClient(): EmbeddingClient {
    return searchSession.queryEmbeddingClient(this)
  }

  private bindPagehide() {
    return searchSession.bindPagehide(this)
  }

  private scheduleFlush(immediate: boolean) {
    return searchSession.scheduleFlush(this, immediate)
  }

  private async flushDiskNow(): Promise<void> {
    return searchSession.flushDiskNow(this)
  }

  private async flushDisk(commit: boolean): Promise<void> {
    return searchSession.flushDisk(this, commit)
  }

  private async removeIndexed(ids: string[]) {
    return searchSession.removeIndexed(this, ids)
  }

  replace(note: StrideNote) {
    this.notes = this.notes.map((item) => (item.id === note.id ? note : item))
  }

  schedule(id: string) {
    this.pendingId = id
    this.saveGeneration += 1
    this.saveStatus = 'pending'
    if (this.docTimer) clearTimeout(this.docTimer)
    // The callback's return value is not awaited by fake timers. Keep the promise.
    this.docTimer = setTimeout(() => {
      this.saveTask = this.flush()
    }, this.autosaveDebounceMs)
    void Promise.all([
      import('../git/git.service'),
      import('../settings/settings.service'),
    ]).then(([gitMod, settingsMod]) => {
      const { GitService } = gitMod
      const { SettingsService } = settingsMod
      if (has(GitService)) this.resolve(GitService).noteActivity()
      // Lazy re-sync of the configured debounce. Value read only — form is a
      // reactive proxy, so never compare object identities here.
      if (has(SettingsService)) {
        const editor = this.resolve(SettingsService).form.editor
        const ms = editor ? editor.autosaveDebounceMs : Number.NaN
        if (Number.isFinite(ms) && ms >= 0 && ms !== this.autosaveDebounceMs) {
          this.autosaveDebounceMs = ms
        }
      }
    })
  }

  private writeProperty(field: string, value: NoteProperty) {
    return propertyEditor.writeProperty(this, field, value)
  }

  // Property wikilinks are the only outgoing links that leave the inbox.
  private maybeAdvanceInbox(before: StrideNote) {
    return propertyEditor.maybeAdvanceInbox(this, before)
  }

  private clearFieldDraft(field: string) {
    return propertyEditor.clearFieldDraft(this, field)
  }

  private resetPropertyEditor() {
    return propertyEditor.resetPropertyEditor(this)
  }

  async deleteActiveNote() {
    const current = this.active
    if (!current || !this.fs) return
    await this.deleteNotes([current.id])
  }

  /** Batch archive: set `archived: true` on each note and save. Thin loop over saveNote. */
  async archiveNotes(ids: string[]) {
    await this.mutateNotes(ids, (note) => ({
      ...note,
      properties: { ...note.properties, archived: true },
    }))
  }

  /** Batch retype: set `type` on each note and save. Thin loop over saveNote. */
  async retypeNotes(ids: string[], type: string) {
    const nextType = type.trim()
    if (!nextType) return
    await this.mutateNotes(ids, (note) => ({ ...note, type: nextType }))
  }

  /**
   * Shared per-note mutate+save for batch operations. Lands any pending
   * debounced save first so a scheduled flush cannot overwrite the mutation.
   * Index text (title + body) is untouched by archive/retype, so no reindex.
   */
  private async mutateNotes(ids: string[], mutate: (note: StrideNote) => StrideNote) {
    const fs = this.fs
    if (!fs || ids.length === 0) return
    const wanted = new Set(ids)
    try {
      await this.flush()
      const saved: StrideNote[] = []
      for (const note of this.notes) {
        if (!wanted.has(note.id)) continue
        saved.push(await saveNote(fs, noteForSave(mutate(note))))
      }
      if (saved.length === 0) return
      const byId = new Map(saved.map((note) => [note.id, note]))
      this.notes = this.notes.map((note) => byId.get(note.id) ?? note)
      const now = Date.now()
      const mtimes = { ...this.noteMtimes }
      for (const note of saved) mtimes[note.id] = now
      this.noteMtimes = mtimes
      this.docEpoch += 1
    } catch (error) {
      this.error = errorText(error)
    }
  }

  /** Batch delete: remove files, drop from the index, fix the active selection. */
  async deleteNotes(ids: string[]) {
    const fs = this.fs
    if (!fs || ids.length === 0) return
    const wanted = new Set(ids)
    try {
      await this.flush()
      // A failed flush leaves a retry timer that would resurrect a deleted file.
      if (this.pendingId && wanted.has(this.pendingId)) this.cancelPending()
      const removed: string[] = []
      for (const id of wanted) {
        await fs.remove(notePath(id))
        removed.push(id)
      }
      await this.removeIndexed(removed)
      this.notes = this.notes.filter((note) => !wanted.has(note.id))
      const mtimes = { ...this.noteMtimes }
      for (const id of removed) delete mtimes[id]
      this.noteMtimes = mtimes
      if (wanted.has(this.activeId)) {
        this.activeId = this.visibleNotes[0]?.id ?? ''
        this.resetPropertyEditor()
      }
      this.docEpoch += 1
    } catch (error) {
      this.error = errorText(error)
    }
  }
}
