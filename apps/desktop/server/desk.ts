import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { NodeFileSystem, NodeGitBackend, NodeSecretsStore, openVaneSearch } from '@stride/platform-node'
import { exitCurrentProcess } from './handoff.ts'
import {
  APP_VERSION,
  EmbeddingClient,
  UpdateController,
  createVaultNote,
  defaultLlmSettings,
  defaultSettings,
  defaultSettingsPath,
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
  noteIndex,
  isLlmProvider,
  notePath,
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
  type LlmConfig,
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
  private readonly settingsName: string
  private readonly markerFile: string
  private readonly configRoot: string
  private readonly configFs: NodeFileSystem
  private readonly secrets = new NodeSecretsStore()
  private readonly git = new NodeGitBackend()
  private readonly homeDir = os.homedir()
  private vaultFs: NodeFileSystem | null = null
  private readonly handoff: AppHandoff
  private readonly ready: Promise<void>

  constructor(settingsFile?: string, hooks?: { handoff?: AppHandoff }) {
    const requested = settingsFile || defaultSettingsPath(os.homedir(), process.env.STRIDE_SETTINGS_PATH || '')
    const location = path.resolve(requested)
    this.settingsFile = location
    this.settingsName = path.basename(location)
    this.configRoot = path.dirname(location)
    this.configFs = new NodeFileSystem(this.configRoot)
    this.settings = defaultSettings()
    this.markerFile = path.join(this.configRoot, 'version-marker.txt')
    this.installPath = path.join(this.configRoot, 'app', 'stride')
    this.handoff = hooks?.handoff ?? (() => exitCurrentProcess())
    this.updater = new UpdateController(this.configFs, APP_VERSION, fetch, (installed) => this.launchInstalled(installed), {
      file: 'version-marker.txt',
      installPath: 'app/stride',
    })
    this.ready = this.loadSettings()
  }

  readonly installPath: string

  restartRequested = false

  private embeddingClient = new EmbeddingClient()

  whenReady(): Promise<void> {
    return this.ready
  }

  private loadSettings(): Promise<void> {
    return readSettings(this.configFs, this.settingsName, this.secrets).then((settings) => {
      this.settings = settings
    })
  }

  async open(vaultPath: string): Promise<{ path: string; broad: boolean; dedicated: boolean; notes: StrideNote[] }> {
    await this.ready
    const backend = new NodeFileSystem(path.resolve(vaultPath))
    const opened = await openVault(backend, this.homeDir)
    this.vaultFs = backend
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

  async create(title?: string): Promise<StrideNote> {
    await this.ready
    this.requireVault()
    const note = await createVaultNote(this.vaultBackend(), title?.trim() || 'Untitled')
    this.notes = await loadNotes(this.vaultBackend())
    void this.upsertOne(note)
    return note
  }

  async save(note: StrideNote): Promise<StrideNote> {
    await this.ready
    this.requireVault()
    const saved = await saveNote(this.vaultBackend(), note)
    this.notes = await loadNotes(this.vaultBackend())
    void this.upsertOne(saved)
    return saved
  }

  async read(id: string): Promise<StrideNote> {
    await this.ready
    this.requireVault()
    return readNoteFile(this.vaultBackend(), notePath(id), id)
  }

  async search(query: string) {
    await this.ready
    if (!this.index) return { mode: 'text' as const, hits: [] as { id: string; score: number }[], error: this.searchError }
    const embedding = this.settings.embedding.apiKey ? this.settings.embedding : null
    const ranked = await searchNotes(this.index, query, embedding, this.embeddingClient)
    return ranked
  }

  async gitInit() {
    await this.ready
    this.requireVault()
    await initGit(this.vaultBackend(), this.git, this.homeDir)
    return gitStatus(this.vaultBackend(), this.git)
  }

  async gitStatus() {
    await this.ready
    this.requireVault()
    return gitStatus(this.vaultBackend(), this.git)
  }

  async gitDiff(id?: string) {
    await this.ready
    this.requireVault()
    return gitDiff(this.vaultBackend(), this.git, id ? this.noteRel(id) : undefined)
  }

  async gitCommit(message: string) {
    await this.ready
    this.requireVault()
    return gitCommit(this.vaultBackend(), this.git, message)
  }

  async gitHistory(id?: string) {
    await this.ready
    this.requireVault()
    return gitHistory(this.vaultBackend(), this.git, id ? this.noteRel(id) : undefined)
  }

  async gitPull() {
    await this.ready
    this.requireVault()
    const result = await gitPull(this.vaultBackend(), this.git)
    await this.reloadNotes()
    return { ...result, notes: this.notes }
  }

  async gitPush() {
    await this.ready
    this.requireVault()
    return gitPush(this.vaultBackend(), this.git)
  }

  async gitRemote(url: string) {
    await this.ready
    this.requireVault()
    return gitAddRemote(this.vaultBackend(), this.git, url)
  }

  async gitResolve(id: string, side: 'ours' | 'theirs') {
    await this.ready
    this.requireVault()
    await gitResolve(this.vaultBackend(), this.git, this.noteRel(id), side)
    await this.reloadNotes()
    return { notes: this.notes }
  }

  async settingsPublic() {
    await this.ready
    return publicSettings(this.settings)
  }

  async saveSettings(incoming: {
    embedding?: { endpoint?: string; model?: string; apiKey?: string; dim?: number }
    llm?: { provider?: string; model?: string; baseUrl?: string; apiKey?: string }
    releasesUrl?: string
  }) {
    await this.ready
    const current = this.settings
    const next: AppSettings = {
      embedding: {
        endpoint: incoming.embedding?.endpoint ?? current.embedding.endpoint,
        model: incoming.embedding?.model ?? current.embedding.model,
        dim: incoming.embedding?.dim || current.embedding.dim || 4,
        apiKey: mergeKey(current.embedding.apiKey, incoming.embedding?.apiKey),
      },
      llmConfigs: applyLlmUpdate(current.llmConfigs, incoming.llm),
      releasesUrl: incoming.releasesUrl ?? current.releasesUrl,
    }
    await writeSettings(this.configFs, this.settingsName, next, this.secrets)
    this.settings = next
    if (this.vaultPath) void this.reindexAll()
    return publicSettings(next)
  }

  async chatTurn(message: string, activeId?: string) {
    await this.ready
    this.requireVault()
    const llm = defaultLlmSettings(this.settings)
    if (!llm || !llm.apiKey || !llm.baseUrl || !llm.model) {
      throw new Error('Add a model provider, base URL, model, and key in Settings')
    }
    const turn = await runVaultTurn({
      settings: llm,
      history: this.chat,
      userText: message,
      tools: vaultTools({
        activeNoteId: activeId,
        readNote: (id) => this.read(id),
        writeSerialized: async (id, serialized) => {
          await this.vaultBackend().writeText(notePath(id), serialized)
          this.notes = await loadNotes(this.vaultBackend())
        },
        searchVault: async (query) => {
          const ranked = await this.search(query)
          return ranked.hits.map((hit) => ({
            id: hit.id,
            title: this.notes.find((note) => note.id === hit.id)?.title ?? hit.id,
            snippet: 'snippet' in hit && typeof hit.snippet === 'string' ? hit.snippet : '',
          }))
        },
        listNotes: async () => this.notes.map((note) => ({ id: note.id, title: note.title })),
        createNote: (title) => this.create(title),
        loadNotes: async () => {
          this.notes = await loadNotes(this.vaultBackend())
          return this.notes
        },
      }),
    })
    this.chat = turn.history
    return { reply: turn.reply, history: this.chat }
  }

  async checkUpdates() {
    await this.ready
    if (!this.settings.releasesUrl) throw new Error('Set a GitHub releases URL in Settings')
    const selected = await this.updater.check(this.settings.releasesUrl)
    return { phase: this.updater.phase, progress: this.updater.progress, selected, version: await this.updater.markerValue() }
  }

  async downloadUpdate() {
    await this.ready
    if (!this.updater.selected) throw new Error('No update is available')
    const dest = `updates/${this.updater.selected.assetName}`
    await this.updater.download(dest)
    return this.updateState()
  }

  async dismissUpdate() {
    await this.ready
    const version = await this.updater.markerValue()
    this.updater.dismiss()
    return { ...(await this.updateState()), version }
  }

  async confirmUpdate() {
    await this.ready
    try {
      await this.updater.confirm()
    } catch (error) {
      if (this.updater.phase === 'ready') this.updater.phase = 'available'
      throw error
    }
    return { ...(await this.updateState()), restartRequested: this.restartRequested }
  }

  private launchInstalled(installed: string): Promise<void> {
    return new Promise((resolve, reject) => {
      let child: ReturnType<typeof spawn>
      try {
        // ENOEXEC is thrown inside spawn(), before this call returns. A listener
        // attached afterwards never sees it, and an uncaught throw kills the API.
        fs.chmodSync(installed, 0o755)
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

  async updateState() {
    await this.ready
    return {
      phase: this.updater.phase,
      progress: this.updater.progress,
      selected: this.updater.selected,
      version: await this.updater.markerValue(),
      downloadedTo: this.updater.downloadedTo ? path.join(this.configRoot, this.updater.downloadedTo) : '',
    }
  }

  private requireVault() {
    if (!this.vaultPath || !this.vaultFs) throw new Error('Open a vault folder first')
  }

  private vaultBackend(): NodeFileSystem {
    this.requireVault()
    return this.vaultFs!
  }

  private noteRel(id: string): string {
    return notePath(id)
  }

  private async reloadNotes() {
    try {
      this.notes = await loadNotes(this.vaultBackend())
      return
    } catch {
      // A conflicted note is not TipTap JSON. Keep the last copy of that file.
    }
    const parsed: StrideNote[] = []
    for (const file of await listNoteFiles(this.vaultBackend())) {
      const id = noteIdFromPath(file)
      try {
        parsed.push(await readNoteFile(this.vaultBackend(), file, id))
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
      const dirRel = '.stride/vane'
      const dimRel = '.stride/vane-dim'
      const dimStat = await this.vaultBackend().stat(dimRel)
      const previous = dimStat ? Number(await this.vaultBackend().readText(dimRel)) : 0
      if (previous && previous !== dim && (await this.vaultBackend().stat(dirRel))) {
        await this.vaultBackend().remove(dirRel)
      }
      await this.vaultBackend().mkdir(dirRel)
      const dir = path.join(this.vaultPath, '.stride', 'vane')
      this.index = noteIndex(await openVaneSearch(dir, dim), dim)
      await this.vaultBackend().writeText(dimRel, `${dim}\n`)
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

function applyLlmUpdate(
  configs: LlmConfig[],
  llm: { provider?: string; model?: string; baseUrl?: string; apiKey?: string } | undefined,
): LlmConfig[] {
  if (!llm) return configs
  const index = configs.findIndex((config) => config.isDefault)
  if (index === -1) {
    const requested = llm.provider
    return [{
      id: 'legacy',
      name: 'LLM',
      provider: requested !== undefined && isLlmProvider(requested) ? requested : 'custom',
      model: llm.model ?? '',
      baseUrl: llm.baseUrl ?? '',
      apiKey: mergeKey('', llm.apiKey),
      isDefault: true,
    }]
  }
  return configs.map((config, configIndex) => {
    if (configIndex !== index) return config
    return {
      ...config,
      provider: llm.provider === undefined ? config.provider : (isLlmProvider(llm.provider) ? llm.provider : 'custom'),
      model: llm.model ?? config.model,
      baseUrl: llm.baseUrl ?? config.baseUrl,
      apiKey: mergeKey(config.apiKey, llm.apiKey),
    }
  })
}
