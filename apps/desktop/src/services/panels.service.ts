import { has, Service } from '@rabjs/react'
import { EmbeddingClient, maskSecret, readSettings, writeSettings, type AppSettings } from '@stride/core'
import { browserGitBackend } from '@stride/git-web'
import { MemoryFileSystem, type SecretsStore } from '@stride/platform'
import { webSecretsStore } from '../../../../packages/secrets-web/src/index.ts'
import { VaultService } from './vault.service'

interface PublicSettings {
  embedding: { endpoint: string; model: string; keyMask: string; dim: number }
  llm: { provider: string; model: string; baseUrl: string; keyMask: string }
  releasesUrl: string
}

const emptySettings = (): PublicSettings => ({
  embedding: { endpoint: '', model: '', keyMask: '', dim: 4 },
  llm: { provider: '', model: '', baseUrl: '', keyMask: '' },
  releasesUrl: '',
})

const GIT_BROWSER = 'Git is not available in the browser'

export class GitService extends Service {
  status = ''
  diff = ''
  history = ''
  message = ''
  remote = ''
  output = ''
  conflicts: string[] = []
  private readonly git = browserGitBackend()

  constructor() {
    super()
    if (!this.git.available) this.output = GIT_BROWSER
  }

  private get vault() {
    return this.resolve(VaultService)
  }

  setMessage(value: string) {
    this.message = value
  }

  setRemote(value: string) {
    this.remote = value
  }

  private browserBlocked(): boolean {
    if (this.git.available) return false
    this.output = GIT_BROWSER
    return true
  }

  async refresh() {
    if (this.browserBlocked()) return
  }

  async init() {
    if (this.browserBlocked()) return
  }

  async commit() {
    try {
      await this.vault.flush()
    } catch (error) {
      this.output = error instanceof Error ? error.message : String(error)
      return
    }
    if (this.browserBlocked()) return
  }

  async pull() {
    if (this.browserBlocked()) return
  }

  async push() {
    if (this.browserBlocked()) return
  }

  async keepSide(_id: string, _side: 'ours' | 'theirs') {
    if (this.browserBlocked()) return
  }
}

export class ChatService extends Service {
  draft = ''
  lines: { role: 'user' | 'assistant'; text: string }[] = []
  error = ''

  setDraft(value: string) {
    this.draft = value
  }

  async send() {
    if (!this.draft.trim()) return
    this.error = 'Agent is not available in the browser'
  }
}

export const SETTINGS_STORAGE_KEY = 'stride:settings'

const SETTINGS_FILE = 'settings.json'

export interface EmbeddingRuntime {
  endpoint: string
  model: string
  apiKey: string
  dim: number
  intended: boolean
  active: boolean
}

type SecretsSource = SecretsStore | (() => Promise<SecretsStore> | SecretsStore)

let secretsOverride: SecretsSource | null = null

export function setSecretsStore(next: SecretsSource | null) {
  secretsOverride = next
}

export function resetSecretsStore() {
  secretsOverride = null
}

function parsePositiveInt(value: string): number | null {
  const trimmed = value.trim()
  if (!/^[1-9]\d*$/.test(trimmed)) return null
  const parsed = Number(trimmed)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return null
  return parsed
}

// Empty clears the stored key. A mask-shaped draft keeps it. Anything else replaces it.
function resolveKey(draft: string, stored: string): string {
  if (draft === '') return ''
  if (draft.startsWith('••••')) return stored
  return draft
}

function keyForTest(draft: string, stored: string): string {
  if (draft === '' || draft.startsWith('••••')) return stored
  return draft
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function settingsFile(): Promise<MemoryFileSystem> {
  const fs = new MemoryFileSystem('settings')
  if (typeof localStorage === 'undefined') return fs
  const raw = localStorage.getItem(SETTINGS_STORAGE_KEY)
  if (raw != null) await fs.writeText(SETTINGS_FILE, raw)
  return fs
}

export class SettingsService extends Service {
  form = emptySettings()
  embeddingKey = ''
  llmKey = ''
  embeddingDimText = '4'
  embeddingTestResult = ''
  notice = ''
  private memoryEmbeddingKey = ''
  private memoryLlmKey = ''
  private loadTask: Promise<void> | null = null
  private loaded = false

  patchEmbedding(partial: Partial<PublicSettings['embedding']>) {
    this.form = { ...this.form, embedding: { ...this.form.embedding, ...partial } }
  }

  patchLlm(partial: Partial<PublicSettings['llm']>) {
    this.form = { ...this.form, llm: { ...this.form.llm, ...partial } }
  }

  setReleasesUrl(value: string) {
    this.form = { ...this.form, releasesUrl: value }
  }

  setEmbeddingDim(value: string) {
    this.embeddingDimText = value
    const parsed = parsePositiveInt(value)
    // Empty or illegal stays off the real vector index. Do not coerce it to a usable width.
    this.patchEmbedding({ dim: parsed ?? 0 })
  }

  embeddingRuntime(): EmbeddingRuntime {
    const dim = parsePositiveInt(this.embeddingDimText)
    const endpoint = this.form.embedding.endpoint.trim()
    const model = this.form.embedding.model.trim()
    const apiKey = this.memoryEmbeddingKey
    const intended = endpoint !== '' && model !== '' && dim !== null
    const active = intended && apiKey !== ''
    return { endpoint, model, apiKey, dim: dim ?? 0, intended, active }
  }

  // Overlapping calls share one read. A later call loads again.
  load(): Promise<void> {
    if (this.loadTask) return this.loadTask
    const task = this.loadBody().finally(() => {
      this.loadTask = null
      this.loaded = true
    })
    this.loadTask = task
    return task
  }

  waitUntilLoaded(): Promise<void> {
    if (this.loaded && !this.loadTask) return Promise.resolve()
    return this.load()
  }

  async save() {
    const before = this.embeddingRuntime()
    const secrets = await this.openSecrets()
    if (!secrets) return
    let after = before
    try {
      const embeddingKey = resolveKey(this.embeddingKey, this.memoryEmbeddingKey)
      const llmKey = resolveKey(this.llmKey, this.memoryLlmKey)
      const dim = parsePositiveInt(this.embeddingDimText)
      const settings: AppSettings = {
        embedding: {
          endpoint: this.form.embedding.endpoint.trim(),
          model: this.form.embedding.model.trim(),
          apiKey: embeddingKey,
          dim: dim ?? 0,
        },
        llm: {
          provider: this.form.llm.provider,
          model: this.form.llm.model,
          baseUrl: this.form.llm.baseUrl,
          apiKey: llmKey,
        },
        releasesUrl: this.form.releasesUrl,
      }
      const fs = await settingsFile()
      await writeSettings(fs, SETTINGS_FILE, settings, secrets)
      const written = await fs.readText(SETTINGS_FILE)
      if ((embeddingKey && written.includes(embeddingKey)) || (llmKey && written.includes(llmKey))) {
        if (typeof localStorage !== 'undefined') localStorage.removeItem(SETTINGS_STORAGE_KEY)
        throw new Error('Refusing to keep a plaintext key')
      }
      if (typeof localStorage !== 'undefined') localStorage.setItem(SETTINGS_STORAGE_KEY, written)
      this.memoryEmbeddingKey = embeddingKey
      this.memoryLlmKey = llmKey
      this.embeddingKey = ''
      this.llmKey = ''
      this.embeddingDimText = dim === null ? this.embeddingDimText : String(dim)
      this.form = {
        embedding: {
          endpoint: settings.embedding.endpoint,
          model: settings.embedding.model,
          keyMask: maskSecret(embeddingKey),
          dim: dim ?? 0,
        },
        llm: {
          provider: settings.llm.provider,
          model: settings.llm.model,
          baseUrl: settings.llm.baseUrl,
          keyMask: maskSecret(llmKey),
        },
        releasesUrl: settings.releasesUrl,
      }
      this.notice = ''
      after = this.embeddingRuntime()
    } catch (error) {
      this.notice = errorText(error)
      return
    }
    await this.syncVault(before, after)
  }

  async testEmbedding() {
    const dim = parsePositiveInt(this.embeddingDimText)
    if (dim === null) {
      this.embeddingTestResult = '维度不符'
      return
    }
    const settings: AppSettings['embedding'] = {
      endpoint: this.form.embedding.endpoint.trim(),
      model: this.form.embedding.model.trim(),
      apiKey: keyForTest(this.embeddingKey, this.memoryEmbeddingKey),
      dim,
    }
    try {
      const [vector] = await new EmbeddingClient((input, init) => globalThis.fetch(input, init)).embed(['连接测试'], settings)
      if (!vector || vector.length !== dim) {
        this.embeddingTestResult = `维度不符: expected ${dim}, got ${vector?.length ?? 0}`
        return
      }
      this.embeddingTestResult = '连接成功'
    } catch (error) {
      this.embeddingTestResult = errorText(error)
    }
  }

  private async loadBody() {
    const secrets = await this.openSecrets()
    if (!secrets) return
    try {
      const settings = await readSettings(await settingsFile(), SETTINGS_FILE, secrets)
      this.memoryEmbeddingKey = settings.embedding.apiKey
      this.memoryLlmKey = settings.llm.apiKey
      this.embeddingKey = ''
      this.llmKey = ''
      this.embeddingDimText = settings.embedding.dim > 0 ? String(settings.embedding.dim) : ''
      this.form = {
        embedding: {
          endpoint: settings.embedding.endpoint,
          model: settings.embedding.model,
          keyMask: maskSecret(settings.embedding.apiKey),
          dim: settings.embedding.dim,
        },
        llm: {
          provider: settings.llm.provider,
          model: settings.llm.model,
          baseUrl: settings.llm.baseUrl,
          keyMask: maskSecret(settings.llm.apiKey),
        },
        releasesUrl: settings.releasesUrl,
      }
      this.notice = ''
    } catch (error) {
      this.notice = errorText(error)
    }
  }

  private async openSecrets(): Promise<SecretsStore | null> {
    if (secretsOverride) {
      try {
        return typeof secretsOverride === 'function' ? await secretsOverride() : secretsOverride
      } catch (error) {
        this.notice = errorText(error)
        return null
      }
    }
    if (typeof globalThis.indexedDB === 'undefined' || !globalThis.indexedDB) return null
    try {
      return await webSecretsStore()
    } catch (error) {
      const message = errorText(error)
      if (message === 'IndexedDB is not available') return null
      this.notice = message
      return null
    }
  }

  private async syncVault(before: EmbeddingRuntime, after: EmbeddingRuntime) {
    if (!has(VaultService)) return
    const vault = this.resolve(VaultService)
    if (vault.phase === 'ready' && vault.fs && (before.dim !== after.dim || before.active !== after.active)) {
      await vault.reopenForSettings()
      return
    }
    if (!after.intended) vault.searchDegraded = false
    else if (!after.active) vault.searchDegraded = true
  }
}

export type UiHandoff = () => void | Promise<void>

// The downloaded asset is already a separate process. relaunch() would start
// this same build again, so the window only needs to exit.
async function exitTauriWindow(): Promise<void> {
  const { exit } = await import('@tauri-apps/plugin-process')
  await exit(0)
}

let uiHandoff: UiHandoff = exitTauriWindow

export function setUiHandoff(next: UiHandoff) {
  uiHandoff = next
}

export function resetUiHandoff() {
  uiHandoff = exitTauriWindow
}

export class UpdateService extends Service {
  phase: 'idle' | 'available' | 'downloading' | 'ready' = 'idle'
  progress = 0
  version = ''
  current = ''
  error = ''

  async check() {}

  async download() {}

  async dismiss() {}

  async confirm() {}
}
