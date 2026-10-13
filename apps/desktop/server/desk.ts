import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { exitCurrentProcess } from './handoff.ts'
import {
  APP_VERSION,
  EmbeddingClient,
  UpdateController,
  createVaultNote,
  gitAddRemote,
  gitCommit,
  gitDiff,
  gitHistory,
  gitPull,
  gitPush,
  gitResolve,
  gitStatus,
  initGit,
  listNoteFiles,
  loadNotes,
  noteIdFromPath,
  notePath,
  openNoteIndex,
  openVault,
  plainText,
  publicSettings,
  readNoteFile,
  readSettings,
  runVaultTurn,
  saveNote,
  searchNotes,
  vaultTools,
  writeSettings,
  type AppSettings,
  type ChatLine,
  type NoteIndex,
  type StrideNote,
} from '@stride/core'

export type AppHandoff = () => void | Promise<void>

// A short-lived shell can take several hundred milliseconds to exit. Handing
// off before that commits the version marker while this build is still running.
const REPLACEMENT_HOLD_MS = 1000

export class Desk {
  vaultPath = ''
  notes: StrideNote[] = []
  index: NoteIndex | null = null
  searchError = ''
  chat: ChatLine[] = []
  settings: AppSettings
  updater: UpdateController
  private readonly settingsFile: string
  private readonly markerFile: string
  private readonly handoff: AppHandoff

  constructor(settingsFile?: string, hooks?: { handoff?: AppHandoff }) {
    this.settingsFile = settingsFile || ''
    this.settings = readSettings(settingsFile)
    const home = path.join(os.homedir(), '.stride')
    this.markerFile = path.join(path.dirname(settingsFile || path.join(home, 'settings.json')), 'version-marker.txt')
    this.installPath = path.join(path.dirname(this.markerFile), 'app', 'stride')
    this.handoff = hooks?.handoff ?? (() => exitCurrentProcess())
    this.updater = new UpdateController(APP_VERSION, fetch, (installed) => this.launchInstalled(installed), {
      file: this.markerFile,
      installPath: this.installPath,
    })
  }

  readonly installPath: string

  restartRequested = false

  private embeddingClient = new EmbeddingClient()

  async open(vaultPath: string): Promise<{ path: string; broad: boolean; dedicated: boolean; notes: StrideNote[] }> {
    const opened = openVault(vaultPath)
    this.vaultPath = opened.path
    this.notes = opened.notes
    this.chat = []
    await this.reindexAll()
    return opened
  }

  snapshot() {
    return {
      path: this.vaultPath,
      notes: this.notes,
      searchError: this.searchError,
      version: APP_VERSION,
    }
  }

  create(title?: string): StrideNote {
    this.requireVault()
    const note = createVaultNote(this.vaultPath, title?.trim() || 'Untitled')
    this.notes = loadNotes(this.vaultPath)
    void this.upsertOne(note)
    return note
  }

  save(note: StrideNote): StrideNote {
    this.requireVault()
    const saved = saveNote(this.vaultPath, note)
    this.notes = loadNotes(this.vaultPath)
    void this.upsertOne(saved)
    return saved
  }

  read(id: string): StrideNote {
    this.requireVault()
    const file = notePath(this.vaultPath, id)
    return readNoteFile(file, id)
  }

  async search(query: string) {
    if (!this.index) return { mode: 'text' as const, hits: [] as { id: string; score: number }[], error: this.searchError }
    const embedding = this.settings.embedding.apiKey ? this.settings.embedding : null
    const ranked = await searchNotes(this.index, query, embedding, this.embeddingClient)
    return ranked
  }

  async gitInit() {
    this.requireVault()
    await initGit(this.vaultPath)
    return gitStatus(this.vaultPath)
  }

  gitStatus() {
    this.requireVault()
    return gitStatus(this.vaultPath)
  }

  gitDiff(id?: string) {
    this.requireVault()
    return gitDiff(this.vaultPath, id ? this.noteRel(id) : undefined)
  }

  gitCommit(message: string) {
    this.requireVault()
    return gitCommit(this.vaultPath, message)
  }

  gitHistory(id?: string) {
    this.requireVault()
    return gitHistory(this.vaultPath, id ? this.noteRel(id) : undefined)
  }

  async gitPull() {
    this.requireVault()
    const result = await gitPull(this.vaultPath)
    this.reloadNotes()
    return { ...result, notes: this.notes }
  }

  gitPush() {
    this.requireVault()
    return gitPush(this.vaultPath)
  }

  gitRemote(url: string) {
    this.requireVault()
    return gitAddRemote(this.vaultPath, url)
  }

  async gitResolve(id: string, side: 'ours' | 'theirs') {
    this.requireVault()
    await gitResolve(this.vaultPath, this.noteRel(id), side)
    this.reloadNotes()
    return { notes: this.notes }
  }

  settingsPublic() {
    return publicSettings(this.settings)
  }

  saveSettings(incoming: {
    embedding?: { endpoint?: string; model?: string; apiKey?: string; dim?: number }
    llm?: { provider?: string; model?: string; baseUrl?: string; apiKey?: string }
    releasesUrl?: string
  }) {
    const current = this.settings
    const next: AppSettings = {
      embedding: {
        endpoint: incoming.embedding?.endpoint ?? current.embedding.endpoint,
        model: incoming.embedding?.model ?? current.embedding.model,
        dim: incoming.embedding?.dim || current.embedding.dim || 4,
        apiKey: mergeKey(current.embedding.apiKey, incoming.embedding?.apiKey),
      },
      llm: {
        provider: incoming.llm?.provider ?? current.llm.provider,
        model: incoming.llm?.model ?? current.llm.model,
        baseUrl: incoming.llm?.baseUrl ?? current.llm.baseUrl,
        apiKey: mergeKey(current.llm.apiKey, incoming.llm?.apiKey),
      },
      releasesUrl: incoming.releasesUrl ?? current.releasesUrl,
    }
    writeSettings(next, this.settingsFile || undefined)
    this.settings = next
    if (this.vaultPath) void this.reindexAll()
    return publicSettings(next)
  }

  async chatTurn(message: string, activeId?: string) {
    this.requireVault()
    if (!this.settings.llm.apiKey || !this.settings.llm.baseUrl || !this.settings.llm.model) {
      throw new Error('Add a model provider, base URL, model, and key in Settings')
    }
    const turn = await runVaultTurn({
      settings: this.settings.llm,
      history: this.chat,
      userText: message,
      tools: vaultTools({
        activeNoteId: activeId,
        readNote: (id) => plainText(this.read(id).doc),
        searchVault: async (query) => {
          const ranked = await this.search(query)
          return ranked.hits.map((hit) => hit.id).join('\n')
        },
        writeNote: (id, text) => {
          const note = this.read(id)
          note.doc = {
            type: 'doc',
            content: [
              ...(note.doc.content || []).filter((node) => node.type === 'heading'),
              { type: 'paragraph', content: [{ type: 'text', text }] },
            ],
          }
          this.save(note)
          return plainText(note.doc)
        },
      }),
    })
    this.chat = turn.history
    return { reply: turn.reply, history: this.chat }
  }

  async checkUpdates() {
    if (!this.settings.releasesUrl) throw new Error('Set a GitHub releases URL in Settings')
    const selected = await this.updater.check(this.settings.releasesUrl)
    return { phase: this.updater.phase, progress: this.updater.progress, selected, version: this.updater.markerValue() }
  }

  async downloadUpdate() {
    if (!this.updater.selected) throw new Error('No update is available')
    const dest = path.join(path.dirname(this.markerFile), 'updates', this.updater.selected.assetName)
    await this.updater.download(dest)
    return this.updateState()
  }

  dismissUpdate() {
    const version = this.updater.markerValue()
    this.updater.dismiss()
    return { ...this.updateState(), version }
  }

  async confirmUpdate() {
    try {
      await this.updater.confirm()
    } catch (error) {
      if (this.updater.phase === 'ready') this.updater.phase = 'available'
      throw error
    }
    return { ...this.updateState(), restartRequested: this.restartRequested }
  }

  private launchInstalled(installed: string): Promise<void> {
    return new Promise((resolve, reject) => {
      let child: ReturnType<typeof spawn>
      try {
        // ENOEXEC is thrown inside spawn(), before this call returns. A listener
        // attached afterwards never sees it, and an uncaught throw kills the API.
        child = spawn(installed, [], { detached: true, stdio: 'ignore' })
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)))
        return
      }
      let settled = false
      let hold: ReturnType<typeof setTimeout> | undefined
      let startup: ReturnType<typeof setTimeout> | undefined
      const fail = (error: Error) => {
        if (settled) return
        settled = true
        if (hold) clearTimeout(hold)
        if (startup) clearTimeout(startup)
        reject(error)
      }
      startup = setTimeout(() => fail(new Error('Update did not start')), 2000)
      child.on('error', (error) => {
        fail(error instanceof Error ? error : new Error(String(error)))
      })
      child.once('exit', (code, signal) => {
        fail(new Error(`Update exited before it stayed running (${code ?? signal})`))
      })
      child.once('spawn', () => {
        if (settled) return
        if (startup) clearTimeout(startup)
        hold = setTimeout(() => {
          if (settled) return
          if (child.exitCode !== null || child.signalCode !== null) {
            fail(new Error(`Update exited before it stayed running (${child.exitCode ?? child.signalCode})`))
            return
          }
          settled = true
          child.unref()
          let pending: Promise<unknown>
          try {
            pending = Promise.resolve(this.handoff())
          } catch (error) {
            stopChild(child)
            this.restartRequested = false
            reject(error instanceof Error ? error : new Error(String(error)))
            return
          }
          void pending.then(() => {
            this.restartRequested = true
            resolve()
          }, (error: unknown) => {
            stopChild(child)
            this.restartRequested = false
            reject(error instanceof Error ? error : new Error(String(error)))
          })
        }, REPLACEMENT_HOLD_MS)
      })
    })
  }

  updateState() {
    return {
      phase: this.updater.phase,
      progress: this.updater.progress,
      selected: this.updater.selected,
      version: this.updater.markerValue(),
      downloadedTo: this.updater.downloadedTo,
    }
  }

  private requireVault() {
    if (!this.vaultPath) throw new Error('Open a vault folder first')
  }

  private noteRel(id: string): string {
    return path.relative(this.vaultPath, notePath(this.vaultPath, id))
  }

  private reloadNotes() {
    try {
      this.notes = loadNotes(this.vaultPath)
      return
    } catch {
      // A conflicted note is not TipTap JSON. Keep the last copy of that file.
    }
    const parsed: StrideNote[] = []
    for (const file of listNoteFiles(this.vaultPath)) {
      const id = noteIdFromPath(this.vaultPath, file)
      try {
        parsed.push(readNoteFile(file, id))
      } catch {
        const previous = this.notes.find((note) => note.id === id)
        if (previous) parsed.push(previous)
      }
    }
    this.notes = parsed
  }

  private async reindexAll() {
    try {
      await this.index?.close()
    } catch {
      // A previous index can fail to close if it never opened.
    }
    this.index = null
    try {
      const docs = this.notes.map((note) => ({ id: note.id, text: `${note.title}\n${plainText(note.doc)}` }))
      let vectors: number[][] | null = null
      if (this.settings.embedding.apiKey && docs.length) {
        vectors = await this.embeddingClient.embed(docs.map((doc) => doc.text), this.settings.embedding)
      }
      const fromVector = vectors?.find((vector) => vector.length > 0)?.length
      const dim = fromVector || this.settings.embedding.dim || 4
      if (fromVector && fromVector !== this.settings.embedding.dim) {
        this.settings = {
          ...this.settings,
          embedding: { ...this.settings.embedding, dim: fromVector },
        }
      }
      const dir = path.join(this.vaultPath, '.stride', 'vane')
      const dimFile = path.join(this.vaultPath, '.stride', 'vane-dim')
      const previous = fs.existsSync(dimFile) ? Number(fs.readFileSync(dimFile, 'utf8')) : 0
      if (previous && previous !== dim && fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true })
      }
      fs.mkdirSync(dir, { recursive: true })
      this.index = await openNoteIndex(dir, dim)
      fs.writeFileSync(dimFile, `${dim}\n`)
      if (docs.length) {
        await this.index.upsert(docs.map((doc, i) => ({ ...doc, vector: vectors?.[i] })))
      }
      this.searchError = ''
    } catch (error) {
      this.searchError = error instanceof Error ? error.message : String(error)
    }
  }

  private async upsertOne(note: StrideNote) {
    try {
      const text = `${note.title}\n${plainText(note.doc)}`
      let vector: number[] | undefined
      if (this.settings.embedding.apiKey) {
        const [embedded] = await this.embeddingClient.embed([text], this.settings.embedding)
        vector = embedded
      }
      if (!this.index || (vector && vector.length !== this.index.dim)) {
        await this.reindexAll()
        return
      }
      await this.index.upsert([{ id: note.id, text, vector }])
    } catch (error) {
      this.searchError = error instanceof Error ? error.message : String(error)
    }
  }
}

function stopChild(child: ReturnType<typeof spawn>) {
  const pid = child.pid
  if (pid) {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      // The child may not be a process-group leader.
    }
  }
  try {
    child.kill('SIGKILL')
  } catch {
    // The replacement already left.
  }
}

function mergeKey(current: string, incoming: string | undefined): string {
  if (incoming === undefined) return current
  if (incoming === '') return ''
  if (incoming.startsWith('••••')) return current
  return incoming
}
