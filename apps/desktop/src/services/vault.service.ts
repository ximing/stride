import { Service } from '@rabjs/react'
import { buildGraph, type VaultGraph } from '@stride/core/graph'
import {
  formatProperty,
  parsePropertyInput,
  plainText,
  type NoteProperty,
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
import { createVaultNote, openVault, saveNote } from '../../../../packages/core/src/vault'

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
  fs: FileSystemBackend | null = null
  private index: NoteIndex | null = null
  private docTimer: ReturnType<typeof setTimeout> | null = null
  private pendingId = ''

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
    this.activeId = id
  }

  get active(): StrideNote | null {
    return this.notes.find((note) => note.id === this.activeId) ?? null
  }

  get graph(): VaultGraph {
    return buildGraph(this.notes)
  }

  get visibleNotes(): StrideNote[] {
    if (this.searchHits.length && this.searchQuery.trim()) {
      const ids = new Set(this.searchHits.map((hit) => hit.id))
      return this.notes.filter((note) => ids.has(note.id))
    }
    if (this.listFilter === 'inbox') return this.graph.inbox
    if (this.listFilter !== 'all') return this.graph.byType.get(this.listFilter) ?? []
    return this.notes
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
        : await pickVaultDirectory()
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

  updateDoc(doc: TipTapNode) {
    const current = this.active
    if (!current) return
    const next = { ...current, doc }
    this.replace(next)
    this.schedule(next.id)
  }

  updateTitle(title: string) {
    const current = this.active
    if (!current) return
    this.replace({ ...current, title })
    this.schedule(current.id)
  }

  updateType(type: string) {
    const current = this.active
    if (!current) return
    this.replace({ ...current, type })
    this.schedule(current.id)
  }

  updateProperty(field: string, raw: string) {
    const current = this.active
    if (!current) return
    const value: NoteProperty = parsePropertyInput(raw)
    const properties = { ...current.properties }
    if (value === '' || (Array.isArray(value) && value.length === 0)) delete properties[field]
    else properties[field] = value
    this.replace({ ...current, properties })
    this.schedule(current.id)
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
    const note = this.notes.find((item) => item.id === id)
    if (!note || !this.fs) return
    const saved = await saveNote(this.fs, note)
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
    this.activeId = opened.notes[0]?.id ?? ''
    this.listFilter = 'all'
    this.searchHits = []
    this.searchQuery = ''
    this.searchMode = ''
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
    if (this.docTimer) clearTimeout(this.docTimer)
    this.docTimer = setTimeout(() => {
      void this.flush().catch((error: unknown) => {
        this.error = errorText(error)
      })
    }, 350)
  }
}
