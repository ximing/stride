import { has, Service } from '@rabjs/react'
import {
  EmbeddingClient,
  catalogDefaultModel,
  effectiveBaseUrl,
  llmProxyBaseUrl,
  maskSecret,
  readSettings,
  testLlmConnection,
  writeSettings,
  type AppSettings,
  type LlmConfig,
  type PublicLlmConfig,
} from '@stride/core'
import { browserGitBackend } from '@stride/git-web'
import { MemoryFileSystem, type SecretsStore } from '@stride/platform'
import { webSecretsStore } from '../../../../packages/secrets-web/src/index.ts'
import { VaultService } from './vault.service'

interface PublicSettings {
  embedding: { endpoint: string; model: string; keyMask: string; dim: number }
  llmConfigs: PublicLlmConfig[]
  releasesUrl: string
}

const emptySettings = (): PublicSettings => ({
  embedding: { endpoint: '', model: '', keyMask: '', dim: 4 },
  llmConfigs: [],
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

// What an index was actually opened with. Dim is 0 unless embedding is active.
export interface IndexSignature {
  endpoint: string
  model: string
  dim: number
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

// An untouched LLM draft is missing and keeps the sealed key. Empty string clears it.
function resolveLlmKey(draft: string | undefined, stored: string): string {
  if (draft === undefined) return stored
  return resolveKey(draft, stored)
}

function keyForTest(draft: string, stored: string): string {
  if (draft === '' || draft.startsWith('••••')) return stored
  return draft
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function openedSignature(runtime: EmbeddingRuntime): IndexSignature {
  return {
    endpoint: runtime.endpoint,
    model: runtime.model,
    dim: runtime.active ? runtime.dim : 0,
    active: runtime.active,
  }
}

function sameIndexSignature(left: IndexSignature, right: IndexSignature): boolean {
  return left.endpoint === right.endpoint
    && left.model === right.model
    && left.dim === right.dim
    && left.active === right.active
}

async function settingsFile(): Promise<MemoryFileSystem> {
  const fs = new MemoryFileSystem('settings')
  if (typeof localStorage === 'undefined') return fs
  const raw = localStorage.getItem(SETTINGS_STORAGE_KEY)
  if (raw != null) await fs.writeText(SETTINGS_FILE, raw)
  return fs
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

export class SettingsService extends Service {
  form = emptySettings()
  embeddingKey = ''
  llmKeyDrafts: Record<string, string> = {}
  selectedLlmId = ''
  embeddingDimText = '4'
  embeddingTestResult = ''
  llmTestResult = ''
  notice = ''
  private memoryEmbeddingKey = ''
  private memoryLlmKeys: Record<string, string> = {}
  private loadTask: Promise<void> | null = null
  private loaded = false

  patchEmbedding(partial: Partial<PublicSettings['embedding']>) {
    this.form = { ...this.form, embedding: { ...this.form.embedding, ...partial } }
  }

  addLlmConfig() {
    const id = crypto.randomUUID()
    const config: PublicLlmConfig = {
      id,
      name: 'OpenAI',
      provider: 'openai',
      model: catalogDefaultModel('openai') || 'gpt-4o-mini',
      baseUrl: '',
      keyMask: '',
      isDefault: this.form.llmConfigs.length === 0,
    }
    this.form = { ...this.form, llmConfigs: [...this.form.llmConfigs, config] }
    this.selectedLlmId = id
  }

  removeLlmConfig(id = this.selectedLlmId) {
    if (!id) return
    const removed = this.form.llmConfigs.find((config) => config.id === id)
    if (!removed) return
    let llmConfigs = this.form.llmConfigs.filter((config) => config.id !== id)
    if (removed.isDefault && llmConfigs.length > 0 && !llmConfigs.some((config) => config.isDefault)) {
      llmConfigs = llmConfigs.map((config, index) => ({ ...config, isDefault: index === 0 }))
    }
    this.form = { ...this.form, llmConfigs }
    const drafts = { ...this.llmKeyDrafts }
    delete drafts[id]
    this.llmKeyDrafts = drafts
    const memory = { ...this.memoryLlmKeys }
    delete memory[id]
    this.memoryLlmKeys = memory
    if (this.selectedLlmId === id) {
      this.selectedLlmId = llmConfigs.find((config) => config.isDefault)?.id ?? llmConfigs[0]?.id ?? ''
    }
  }

  setDefaultLlmConfig(id = this.selectedLlmId) {
    if (!id || !this.form.llmConfigs.some((config) => config.id === id)) return
    this.form = {
      ...this.form,
      llmConfigs: this.form.llmConfigs.map((config) => ({ ...config, isDefault: config.id === id })),
    }
  }

  patchLlmConfig(partial: { name?: string; provider?: string; model?: string; baseUrl?: string }) {
    const current = this.form.llmConfigs.find((config) => config.id === this.selectedLlmId)
    if (!current) return
    let model = current.model
    if (partial.provider !== undefined && partial.provider !== current.provider && partial.model === undefined) {
      const previousDefault = catalogDefaultModel(current.provider)
      if (!current.model.trim() || current.model === previousDefault) model = catalogDefaultModel(partial.provider)
    }
    if (partial.model !== undefined) model = partial.model
    const next: PublicLlmConfig = { ...current, ...partial, model }
    this.form = {
      ...this.form,
      llmConfigs: this.form.llmConfigs.map((config) => config.id === current.id ? next : config),
    }
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

  llmRuntime(): { provider: string; model: string; baseUrl: string; apiKey: string } | null {
    const config = this.form.llmConfigs.find((item) => item.isDefault)
    if (!config) return null
    return {
      provider: config.provider,
      model: config.model,
      baseUrl: effectiveBaseUrl(config),
      apiKey: this.memoryLlmKeys[config.id] ?? '',
    }
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
    const secrets = await this.openSecrets()
    if (!secrets) return
    let after: EmbeddingRuntime
    try {
      const embeddingKey = resolveKey(this.embeddingKey, this.memoryEmbeddingKey)
      const llmConfigs: LlmConfig[] = this.form.llmConfigs.map((config) => ({
        id: config.id,
        name: config.name,
        provider: config.provider,
        model: config.model,
        baseUrl: config.baseUrl,
        apiKey: resolveLlmKey(this.llmKeyDrafts[config.id], this.memoryLlmKeys[config.id] ?? ''),
        isDefault: config.isDefault,
      }))
      const dim = parsePositiveInt(this.embeddingDimText)
      const settings: AppSettings = {
        embedding: {
          endpoint: this.form.embedding.endpoint.trim(),
          model: this.form.embedding.model.trim(),
          apiKey: embeddingKey,
          dim: dim ?? 0,
        },
        llmConfigs,
        releasesUrl: this.form.releasesUrl,
      }
      const fs = await settingsFile()
      await writeSettings(fs, SETTINGS_FILE, settings, secrets)
      const written = await fs.readText(SETTINGS_FILE)
      const rawKeys = [embeddingKey, ...llmConfigs.map((config) => config.apiKey)].filter((key) => key)
      if (rawKeys.some((key) => written.includes(key))) {
        if (typeof localStorage !== 'undefined') localStorage.removeItem(SETTINGS_STORAGE_KEY)
        throw new Error('Refusing to keep a plaintext key')
      }
      if (typeof localStorage !== 'undefined') localStorage.setItem(SETTINGS_STORAGE_KEY, written)
      this.memoryEmbeddingKey = embeddingKey
      this.memoryLlmKeys = Object.fromEntries(llmConfigs.map((config) => [config.id, config.apiKey]))
      this.embeddingKey = ''
      this.llmKeyDrafts = {}
      this.embeddingDimText = dim === null ? this.embeddingDimText : String(dim)
      this.form = {
        embedding: {
          endpoint: settings.embedding.endpoint,
          model: settings.embedding.model,
          keyMask: maskSecret(embeddingKey),
          dim: dim ?? 0,
        },
        llmConfigs: llmConfigs.map((config) => ({
          id: config.id,
          name: config.name,
          provider: config.provider,
          model: config.model,
          baseUrl: config.baseUrl,
          keyMask: maskSecret(config.apiKey),
          isDefault: config.isDefault,
        })),
        releasesUrl: settings.releasesUrl,
      }
      this.notice = ''
      after = this.embeddingRuntime()
    } catch (error) {
      this.notice = errorText(error)
      return
    }
    await this.syncVault(after)
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

  async testSelectedLlm() {
    const current = this.form.llmConfigs.find((config) => config.id === this.selectedLlmId)
    if (!current) {
      this.llmTestResult = 'Missing model'
      return
    }
    const config: LlmConfig = {
      id: current.id,
      name: current.name,
      provider: current.provider,
      model: current.model,
      baseUrl: current.baseUrl,
      apiKey: keyForTest(this.llmKeyDrafts[current.id] ?? '', this.memoryLlmKeys[current.id] ?? ''),
      isDefault: current.isDefault,
    }
    const configured = effectiveBaseUrl(config)
    let baseUrl: string | undefined
    if (import.meta.env.DEV && isHttpUrl(configured)) {
      try {
        const path = llmProxyBaseUrl(configured)
        const origin = globalThis.location?.origin
        // pi-ai rejects a relative base URL. Same-origin keeps the request on the dev proxy.
        baseUrl = origin && origin !== 'null' ? `${origin}${path}` : path
      } catch {
        baseUrl = undefined
      }
    }
    const result = await testLlmConnection(config, { fetch: globalThis.fetch.bind(globalThis), baseUrl })
    this.llmTestResult = result.ok ? '连接成功' : result.error
  }

  private async loadBody() {
    const secrets = await this.openSecrets()
    if (!secrets) return
    try {
      const settings = await readSettings(await settingsFile(), SETTINGS_FILE, secrets)
      this.memoryEmbeddingKey = settings.embedding.apiKey
      this.memoryLlmKeys = Object.fromEntries(settings.llmConfigs.map((config) => [config.id, config.apiKey]))
      this.embeddingKey = ''
      this.llmKeyDrafts = {}
      this.embeddingDimText = settings.embedding.dim > 0 ? String(settings.embedding.dim) : ''
      const preferred = settings.llmConfigs.find((config) => config.isDefault) ?? settings.llmConfigs[0]
      this.selectedLlmId = preferred?.id ?? ''
      this.form = {
        embedding: {
          endpoint: settings.embedding.endpoint,
          model: settings.embedding.model,
          keyMask: maskSecret(settings.embedding.apiKey),
          dim: settings.embedding.dim,
        },
        llmConfigs: settings.llmConfigs.map((config) => ({
          id: config.id,
          name: config.name,
          provider: config.provider,
          model: config.model,
          baseUrl: config.baseUrl,
          keyMask: maskSecret(config.apiKey),
          isDefault: config.isDefault,
        })),
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

  private async syncVault(after: EmbeddingRuntime) {
    if (!has(VaultService)) return
    const vault = this.resolve(VaultService)
    const next = openedSignature(after)
    if (vault.phase === 'ready' && vault.fs && !sameIndexSignature(vault.indexSignature, next)) {
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
