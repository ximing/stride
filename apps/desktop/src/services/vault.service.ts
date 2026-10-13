import { Service } from '@rabjs/react'
import { buildGraph, type VaultGraph } from '@stride/core/graph'
import {
  applyBody,
  applyTitle,
  formatProperty,
  isPlaceholderTitle,
  noteForSave,
  parseFiniteNumber,
  parseListInput,
  parsePropertyInput,
  plainText,
  type NoteProperty,
  type PropertyKind,
  type StrideNote,
  type TipTapNode,
} from '@stride/core/note'
import { pickVaultDirectory, restoreVaultDirectory } from '@stride/fs-web'
import {
  MemoryFileSystem,
  memorySearchOpener,
  type FileSystemBackend,
  type SearchBackendOpener,
} from '@stride/platform'
import { EmbeddingClient } from '../../../../packages/core/src/embeddings'
import { noteIndex, searchNotes, type NoteIndex } from '../../../../packages/core/src/search'
import { writeSampleNotes } from '../../../../packages/core/src/sample'
import { initializeVault } from '../../../../packages/core/src/seed'
import { compareTypeDocuments, isTypeVisible, nextTypeOrder, templateBody } from '../../../../packages/core/src/types'
import { readRenameFromHeading, writeRenameFromHeading } from '../../../../packages/core/src/vault-config'
import { createVaultNote, nextSlugId, notePath, openVault, saveNote } from '../../../../packages/core/src/vault'

const COLLAPSED_TYPES_KEY = 'stride:collapsed-types'

// The browser has no home directory. openVault only uses this to reject broad personal roots.
const HOME_DIR = '/Users/stride'

// Text mode passes a null embedding. This throws if searchNotes starts calling embed anyway.
class TextOnlyEmbeddingClient extends EmbeddingClient {
  override embed(): Promise<number[][]> {
    throw new Error('text search must not embed')
  }
}

const embeddingClient = new TextOnlyEmbeddingClient()

function isMemoryFixture(): boolean {
  return new URLSearchParams(window.location.search).get('fixture') === 'memory'
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function indexText(note: StrideNote): string {
  return `${note.title}\n${plainText(note.doc)}`
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

function hasTauriInternals(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

async function pickVaultBackend(): Promise<FileSystemBackend> {
  if (!hasTauriInternals()) return pickVaultDirectory()
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
  pathDraft = ''
  broad = false
  notes: StrideNote[] = []
  activeId = ''
  listFilter = 'all'
  error = ''
  searchQuery = ''
  searchHits: { id: string; score: number }[] = []
  searchMode = ''
  panel: 'properties' | 'git' | 'chat' | 'settings' = 'properties'
  docEpoch = 0
  renameFromHeading = true
  propertyName = ''
  propertyType: PropertyKind = 'string'
  propertyValue = ''
  propertyChecked = false
  collapsedTypes: string[] = readCollapsedTypes()
  fs: FileSystemBackend | null = null
  private index: NoteIndex | null = null
  private docTimer: ReturnType<typeof setTimeout> | null = null
  private pendingId = ''
  private renaming = false
  private numberDrafts: Record<string, string> = {}
  private listDrafts: Record<string, string> = {}
  private saveGeneration = 0

  setPathDraft(value: string) {
    this.pathDraft = value
  }

  setPanel(panel: VaultService['panel']) {
    this.panel = panel
  }

  setFilter(filter: string) {
    this.listFilter = filter
  }

  select(id: string) {
    if (id === this.activeId) return
    void this.commitHeadingRename()
    this.activeId = id
    this.resetPropertyEditor()
  }

  get active(): StrideNote | null {
    return this.notes.find((note) => note.id === this.activeId) ?? null
  }

  get graph(): VaultGraph {
    return buildGraph(this.notes)
  }

  get typeDocuments(): StrideNote[] {
    return this.notes.filter((note) => isTypeDocument(note)).sort(compareTypeDocuments)
  }

  get sidebarTypes(): StrideNote[] {
    return this.typeDocuments.filter((note) => isTypeVisible(note))
  }

  get typeInstances(): StrideNote[] {
    const active = this.active
    if (!active || !isTypeDocument(active)) return []
    return this.notes.filter((note) => note.id !== active.id && note.type === active.title)
  }

  toggleTypeCollapsed(title: string) {
    const next = this.collapsedTypes.includes(title)
      ? this.collapsedTypes.filter((item) => item !== title)
      : [...this.collapsedTypes, title]
    this.collapsedTypes = next
    writeCollapsedTypes(next)
  }

  get inboxCount(): number {
    return this.graph.inbox.filter((note) => !isTypeDocument(note)).length
  }

  get visibleNotes(): StrideNote[] {
    const listed = (notes: StrideNote[]) => notes.filter((note) => !isTypeDocument(note))
    if (this.searchHits.length && this.searchQuery.trim()) {
      const ids = new Set(this.searchHits.map((hit) => hit.id))
      return listed(this.notes.filter((note) => ids.has(note.id)))
    }
    if (this.listFilter === 'inbox') return listed(this.graph.inbox)
    if (this.listFilter !== 'all') return listed(this.graph.byType.get(this.listFilter) ?? [])
    return listed(this.notes)
  }

  async restoreOpened() {
    if (isMemoryFixture()) return
    try {
      const restored = await restoreVaultDirectory()
      if (!restored) return
      await this.openBackend(restored)
    } catch (error) {
      this.error = errorText(error)
    }
  }

  async openFromDraft() {
    this.error = ''
    try {
      const backend = isMemoryFixture()
        ? new MemoryFileSystem('memory-vault')
        : await pickVaultBackend()
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
    this.replace({ ...current, title: next.title, doc: next.doc })
    if (next.lifted) this.docEpoch += 1
    this.schedule(current.id)
  }

  updateTitle(title: string) {
    const current = this.active
    if (!current) return
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

  async commitHeadingRename() {
    if (this.renaming) return
    const leaving = this.active
    const fs = this.fs
    if (!leaving || !fs) return
    const fromId = leaving.id
    this.renaming = true
    try {
      await this.flush()
      if (!this.renameFromHeading) return
      const fresh = this.notes.find((note) => note.id === fromId)
      if (!fresh || isPlaceholderTitle(fresh.title)) return
      const nextId = await nextSlugId(fs, fresh.title, fresh.id)
      if (nextId === fresh.id) return
      await fs.rename(notePath(fromId), notePath(nextId))
      const latest = this.notes.find((note) => note.id === fromId) ?? fresh
      const renamed: StrideNote = { ...latest, id: nextId }
      this.notes = this.notes.map((note) => (note.id === fromId ? renamed : note))
      if (this.activeId === fromId) this.activeId = nextId
      if (this.pendingId === fromId) this.pendingId = nextId
      await this.index?.remove([fromId])
      await this.upsertIndexed(renamed)
    } catch (error) {
      this.error = errorText(error)
    } finally {
      this.renaming = false
    }
  }

  updateType(type: string) {
    const current = this.active
    if (!current) return
    this.replace({ ...current, type })
    this.schedule(current.id)
  }

  setPropertyName(value: string) {
    this.propertyName = value
  }

  setPropertyType(value: string) {
    if (value === 'string' || value === 'number' || value === 'boolean' || value === 'list') {
      this.propertyType = value
    }
  }

  setPropertyValue(value: string) {
    this.propertyValue = value
  }

  setPropertyChecked(value: boolean) {
    this.propertyChecked = value
  }

  addProperty() {
    const field = this.propertyName.trim()
    if (!field || !this.active) return
    let next: NoteProperty | undefined
    if (this.propertyType === 'boolean') next = this.propertyChecked
    else if (this.propertyType === 'number') next = parseFiniteNumber(this.propertyValue)
    else if (this.propertyType === 'list') {
      const items = parseListInput(this.propertyValue)
      if (items.length > 0) next = items
    } else {
      const parsed = parsePropertyInput(this.propertyValue)
      if (parsed !== '' && !(Array.isArray(parsed) && parsed.length === 0)) next = parsed
    }
    if (next === undefined) return
    this.clearFieldDraft(field)
    this.writeProperty(field, next)
    this.propertyName = ''
    this.propertyValue = ''
    this.propertyChecked = false
  }

  updateProperty(field: string, raw: string) {
    const current = this.active
    if (!current) return
    const value: NoteProperty = parsePropertyInput(raw)
    const properties = { ...current.properties }
    if (value === '' || (Array.isArray(value) && value.length === 0)) delete properties[field]
    else properties[field] = value
    this.clearFieldDraft(field)
    this.replace({ ...current, properties })
    this.schedule(current.id)
  }

  updateListProperty(field: string, raw: string) {
    const items = parseListInput(raw)
    if (items.length === 0) {
      this.removeProperty(field)
      return
    }
    this.listDrafts = { ...this.listDrafts, [field]: raw }
    this.writeProperty(field, items)
  }

  updateNumberProperty(field: string, raw: string) {
    if (raw.trim() === '') {
      this.removeProperty(field)
      return
    }
    this.numberDrafts = { ...this.numberDrafts, [field]: raw }
    const parsed = parseFiniteNumber(raw)
    if (parsed === undefined) return
    this.writeProperty(field, parsed)
  }

  updateBooleanProperty(field: string, value: boolean) {
    this.writeProperty(field, value)
  }

  removeProperty(field: string) {
    const current = this.active
    this.clearFieldDraft(field)
    if (!current || !Object.hasOwn(current.properties, field)) return
    const properties = { ...current.properties }
    delete properties[field]
    this.replace({ ...current, properties })
    this.schedule(current.id)
  }

  commitListProperty(field: string) {
    const raw = this.listDrafts[field]
    if (raw !== undefined) {
      this.clearFieldDraft(field)
      const items = parseListInput(raw)
      if (items.length === 0) this.removeProperty(field)
      else this.writeProperty(field, items)
    }
    this.blurProperty()
  }

  commitNumberProperty(field: string) {
    const raw = this.numberDrafts[field]
    if (raw !== undefined) {
      this.clearFieldDraft(field)
      if (raw.trim() === '') this.removeProperty(field)
      else {
        const parsed = parseFiniteNumber(raw)
        if (parsed !== undefined) this.writeProperty(field, parsed)
      }
    }
    this.blurProperty()
  }

  blurProperty() {
    void this.flush().catch((error: unknown) => {
      this.error = errorText(error)
    })
  }

  numberText(field: string): string {
    if (Object.hasOwn(this.numberDrafts, field)) return this.numberDrafts[field] ?? ''
    const value = this.active?.properties[field]
    return typeof value === 'number' ? String(value) : ''
  }

  listText(field: string): string {
    if (Object.hasOwn(this.listDrafts, field)) return this.listDrafts[field] ?? ''
    return formatProperty(this.active?.properties[field])
  }

  propertyText(field: string): string {
    return formatProperty(this.active?.properties[field])
  }

  async runSearch() {
    this.error = ''
    try {
      if (!this.index) throw new Error('Open a vault first')
      const result = await searchNotes(this.index, this.searchQuery, null, embeddingClient)
      this.searchMode = result.mode
      this.searchHits = result.hits
    } catch (error) {
      this.error = errorText(error)
    }
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
  }

  async flush(): Promise<void> {
    if (this.docTimer) {
      clearTimeout(this.docTimer)
      this.docTimer = null
    }
    const id = this.pendingId
    if (!id) return
    this.pendingId = ''
    const generation = this.saveGeneration
    const note = this.notes.find((item) => item.id === id)
    if (!note || !this.fs) return
    const saved = await saveNote(this.fs, noteForSave(note))
    // A newer edit landed while the file write was in flight.
    if (generation !== this.saveGeneration) return
    this.replace(saved)
    await this.upsertIndexed(saved)
  }

  private async openBackend(backend: FileSystemBackend) {
    const opened = await openVault(backend, HOME_DIR)
    const opener = await this.searchOpener()
    const search = await opener.open({ vaultKey: backend.rootLabel, dim: 0 })
    const index = noteIndex(search, 0)
    if (opened.notes.length) {
      await index.upsert(opened.notes.map((note) => ({ id: note.id, text: indexText(note) })))
    }
    await this.index?.close().catch(() => undefined)
    this.index = index
    this.fs = backend
    this.vaultPath = opened.path
    this.broad = opened.broad
    this.notes = opened.notes
    this.docEpoch += 1
    this.activeId = opened.notes.find((note) => !isTypeDocument(note))?.id ?? ''
    this.listFilter = 'all'
    this.searchHits = []
    this.searchQuery = ''
    this.searchMode = ''
    this.renameFromHeading = await readRenameFromHeading(backend)
    this.resetPropertyEditor()
    this.phase = 'ready'
  }

  private async searchOpener(): Promise<SearchBackendOpener> {
    if (isMemoryFixture()) return memorySearchOpener()
    const { vaneWebSearchOpener } = await import('@stride/search-web')
    return vaneWebSearchOpener()
  }

  private async upsertIndexed(note: StrideNote) {
    if (!this.index) return
    await this.index.upsert([{ id: note.id, text: indexText(note) }])
  }

  private replace(note: StrideNote) {
    this.notes = this.notes.map((item) => (item.id === note.id ? note : item))
  }

  private schedule(id: string) {
    this.pendingId = id
    this.saveGeneration += 1
    if (this.docTimer) clearTimeout(this.docTimer)
    this.docTimer = setTimeout(() => {
      void this.flush().catch((error: unknown) => {
        this.error = errorText(error)
      })
    }, 350)
  }

  private writeProperty(field: string, value: NoteProperty) {
    const current = this.active
    if (!current) return
    this.replace({ ...current, properties: { ...current.properties, [field]: value } })
    this.schedule(current.id)
  }

  private clearFieldDraft(field: string) {
    if (Object.hasOwn(this.numberDrafts, field)) {
      const numberDrafts = { ...this.numberDrafts }
      delete numberDrafts[field]
      this.numberDrafts = numberDrafts
    }
    if (Object.hasOwn(this.listDrafts, field)) {
      const listDrafts = { ...this.listDrafts }
      delete listDrafts[field]
      this.listDrafts = listDrafts
    }
  }

  private resetPropertyEditor() {
    this.propertyName = ''
    this.propertyType = 'string'
    this.propertyValue = ''
    this.propertyChecked = false
    this.numberDrafts = {}
    this.listDrafts = {}
  }
}
