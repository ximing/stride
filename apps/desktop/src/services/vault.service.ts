import { Service } from '@rabjs/react'
import { buildGraph, type VaultGraph } from '@stride/core/graph'
import { formatProperty, parsePropertyInput, type NoteProperty, type StrideNote, type TipTapNode } from '@stride/core/note'
import { api } from '../api'

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

  async openFromDraft() {
    this.error = ''
    try {
      const opened = await api.openVault(this.pathDraft.trim())
      this.vaultPath = opened.path
      this.broad = opened.broad
      this.notes = opened.notes
      this.docEpoch += 1
      this.activeId = opened.notes[0]?.id ?? ''
      this.phase = 'ready'
      this.listFilter = 'all'
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error)
    }
  }

  async createNote() {
    this.error = ''
    try {
      const note = await api.createNote('Untitled')
      this.notes = [note, ...this.notes.filter((item) => item.id !== note.id)]
      this.activeId = note.id
      this.listFilter = 'all'
      this.searchHits = []
      this.searchQuery = ''
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error)
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
      const result = await api.search(this.searchQuery)
      this.searchMode = result.mode
      this.searchHits = result.hits
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error)
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
    if (!note) return
    await api.saveNote(note)
  }

  private replace(note: StrideNote) {
    this.notes = this.notes.map((item) => (item.id === note.id ? note : item))
  }

  private schedule(id: string) {
    this.pendingId = id
    if (this.docTimer) clearTimeout(this.docTimer)
    this.docTimer = setTimeout(() => {
      void this.flush().catch((error: unknown) => {
        this.error = error instanceof Error ? error.message : String(error)
      })
    }, 350)
  }
}
