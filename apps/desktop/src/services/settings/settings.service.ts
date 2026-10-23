import { has, Service } from '@rabjs/react'
import {
  EmbeddingClient,
  canonicalEmbeddingEndpoint,
  catalogDefaultModel,
  effectiveBaseUrl,
  llmProxyBaseUrl,
  addTokenUsageDay,
  emptyTokenHistory,
  emptyTokenUsage,
  localDateKey,
  maskSecret,
  parseTokenUsage,
  readSettings,
  readTokenUsageHistory,
  testLlmConnection,
  writeSettings,
  writeTokenUsageHistory,
  type TokenUsageHistory,
  type TokenUsageSample,
  type AppSettings,
  type LlmConfig,
  type PublicLlmConfig,
} from '@stride/core'
import { MemoryFileSystem, type FileSystemBackend, type SecretsStore } from '@stride/platform'
import { webSecretsStore } from '@stride/secrets-web'
import { isDesktopRuntime } from '../platform/runtime'
import { VaultService } from '../vault/vault.service'

interface PublicSettings {
  embedding: { endpoint: string; model: string; keyMask: string; dim: number }
  llmConfigs: PublicLlmConfig[]
  releasesUrl: string
  gitEnabled: boolean
  autoSyncMinutes: number
  autoGitEnabled: boolean
  autoGitIdleSeconds: number
  autoGitBlurSeconds: number
  appearance: AppSettings['appearance']
  editor: AppSettings['editor']
  updates: AppSettings['updates']
  privacy: AppSettings['privacy']
}

const emptySettings = (): PublicSettings => ({
  embedding: { endpoint: '', model: '', keyMask: '', dim: 4 },
  llmConfigs: [],
  releasesUrl: '',
  gitEnabled: true,
  autoSyncMinutes: 0,
  autoGitEnabled: false,
  autoGitIdleSeconds: 0,
  autoGitBlurSeconds: 0,
  appearance: { noteWidth: 'standard', fontSize: 15 },
  editor: { autosaveDebounceMs: 350 },
  updates: { channel: 'stable', autoCheck: true },
  privacy: { telemetryEnabled: false },
})

export const SETTINGS_STORAGE_KEY = 'stride:settings'
export const TOKEN_USAGE_STORAGE_KEY = 'stride:token-usage'

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

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

// Fields the snapshot did not change stay on `fallback` (the newer load or save).
function mergePartitions(preferred: PublicSettings, baseline: PublicSettings, fallback: PublicSettings): PublicSettings {
  const pick = <K extends keyof PublicSettings>(key: K): PublicSettings[K] => (
    sameJson(preferred[key], baseline[key]) ? fallback[key] : preferred[key]
  )
  return {
    embedding: pick('embedding'),
    llmConfigs: pick('llmConfigs'),
    releasesUrl: pick('releasesUrl'),
    gitEnabled: pick('gitEnabled'),
    autoSyncMinutes: pick('autoSyncMinutes'),
    autoGitEnabled: pick('autoGitEnabled'),
    autoGitIdleSeconds: pick('autoGitIdleSeconds'),
    autoGitBlurSeconds: pick('autoGitBlurSeconds'),
    appearance: pick('appearance'),
    editor: pick('editor'),
    updates: pick('updates'),
    privacy: pick('privacy'),
  }
}

function keySealValues(value: unknown, found: string[]): void {
  if (!value || typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (const item of value) keySealValues(item, found)
    return
  }
  for (const [name, child] of Object.entries(value as Record<string, unknown>)) {
    if (name === 'keySeal' && typeof child === 'string') {
      if (child) found.push(child)
      continue
    }
    if (child && typeof child === 'object') keySealValues(child, found)
  }
}

// keyMask legally repeats the last 4 characters. Only a keySeal can leak.
function keySealContainsPlaintext(written: string, rawKeys: string[]): boolean {
  let parsed: unknown
  try {
    parsed = JSON.parse(written)
  } catch {
    return true
  }
  const seals: string[] = []
  keySealValues(parsed, seals)
  return rawKeys.some((key) => seals.some((seal) => seal.includes(key)))
}

interface SettingsShot {
  form: PublicSettings
  baseline: PublicSettings
  embeddingKey: string
  llmKeyDrafts: Record<string, string>
  embeddingDimText: string
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
  tokenHistory: TokenUsageHistory = emptyTokenHistory()
  usageVaultOpen = false
  private usageFs: FileSystemBackend | null = null
  private usageChain: Promise<void> = Promise.resolve()
  private usageEpoch = 0
  private usageRevision = 0
  // replay: already inside tokenHistory, still missing from the vault file.
  private pendingUsage: Array<{
    sample: TokenUsageSample
    date: string
    replay: boolean
    revision: number
  }> = []
  private memoryEmbeddingKey = ''
  private memoryLlmKeys: Record<string, string> = {}
  private loadTask: Promise<void> | null = null
  private loaded = false
  // load and save share this so an older snapshot cannot land after a newer partition.
  private ioChain: Promise<void> = Promise.resolve()
  // Last form read or written. A save captured before that must not put defaults back.
  private committedForm: PublicSettings = emptySettings()

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

  // Sectioned settings UI: picking a row selects it for editing and drops the
  // stale probe result from whichever config was tested before.
  selectLlmConfig(id: string) {
    if (!this.form.llmConfigs.some((config) => config.id === id)) return
    this.selectedLlmId = id
    this.llmTestResult = ''
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

  setGitEnabled(value: boolean) {
    this.form = { ...this.form, gitEnabled: value }
  }

  setAutoSyncMinutes(value: number) {
    const minutes = typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
    this.form = { ...this.form, autoSyncMinutes: minutes }
  }

  setAutoGitEnabled(value: boolean) {
    this.form = { ...this.form, autoGitEnabled: value === true }
  }

  setAutoGitIdleSeconds(value: number) {
    const seconds = typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
    this.form = { ...this.form, autoGitIdleSeconds: seconds }
  }

  setAutoGitBlurSeconds(value: number) {
    const seconds = typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
    this.form = { ...this.form, autoGitBlurSeconds: seconds }
  }

  setEmbeddingDim(value: string) {
    this.embeddingDimText = value
    const parsed = parsePositiveInt(value)
    // Empty or illegal stays off the real vector index. Do not coerce it to a usable width.
    this.patchEmbedding({ dim: parsed ?? 0 })
  }

  embeddingRuntime(): EmbeddingRuntime {
    const dim = parsePositiveInt(this.embeddingDimText)
    const endpoint = canonicalEmbeddingEndpoint(this.form.embedding.endpoint)
    const model = this.form.embedding.model.trim()
    const apiKey = this.memoryEmbeddingKey
    const intended = endpoint !== '' && model !== '' && dim !== null
    const active = intended && apiKey !== ''
    return { endpoint, model, apiKey, dim: dim ?? 0, intended, active }
  }

  /** Add one model call on today's local date and write it into the open vault. */
  recordTokenUsage(sample: TokenUsageSample | null) {
    if (!sample) return
    const date = localDateKey()
    const next = addTokenUsageDay(this.tokenHistory, sample, date)
    if (next === this.tokenHistory) return
    this.tokenHistory = next
    const revision = ++this.usageRevision
    const fs = this.usageFs
    if (!fs) {
      this.pendingUsage.push({ sample, date, replay: false, revision })
      return
    }
    const snapshot = next
    this.usageChain = this.usageChain.catch(() => undefined).then(async () => {
      const saved = await this.persistUsage(fs, snapshot)
      if (saved) this.dropReplay(revision, snapshot)
      else this.pendingUsage.push({ sample, date, replay: true, revision })
    })
  }

  /** Load this vault's history. A null backend clears it when the chooser is showing. */
  bindUsageVault(fs: FileSystemBackend | null): Promise<void> {
    const epoch = ++this.usageEpoch
    this.usageVaultOpen = fs !== null
    this.usageChain = this.usageChain.catch(() => undefined).then(async () => {
      if (this.usageEpoch !== epoch) return
      await this.activateUsageVault(fs)
    }).catch(() => undefined)
    return this.usageChain
  }

  whenTokenUsageSettled(): Promise<void> {
    return this.usageChain
  }

  private async activateUsageVault(fs: FileSystemBackend | null) {
    if (!fs) {
      const previous = this.usageFs
      if (previous && this.pendingUsage.some((item) => item.replay)) {
        try {
          await writeTokenUsageHistory(previous, this.tokenHistory)
        } catch (error) {
          console.warn(`stride token usage: write-failed ${errorText(error)}`)
        }
      }
      this.usageFs = null
      this.usageVaultOpen = false
      this.pendingUsage = []
      this.tokenHistory = emptyTokenHistory()
      return
    }
    const carried = this.pendingUsage.splice(0)
    let history = await readTokenUsageHistory(fs)
    for (const item of carried) history = addTokenUsageDay(history, item.sample, item.date)
    const legacy = this.readLegacyUsage()
    const today = localDateKey()
    for (const row of legacy.models) history = addTokenUsageDay(history, row, today)
    this.usageFs = fs
    this.usageVaultOpen = true
    this.tokenHistory = history
    if (carried.length === 0 && legacy.models.length === 0) return
    const saved = await this.persistUsage(fs, history)
    if (saved) {
      if (legacy.models.length > 0 && typeof localStorage !== 'undefined') {
        localStorage.removeItem(TOKEN_USAGE_STORAGE_KEY)
      }
      return
    }
    const revision = this.usageRevision
    const replay = carried.map((item) => ({ sample: item.sample, date: item.date, replay: true, revision }))
    this.pendingUsage = [...replay, ...this.pendingUsage]
  }

  // One immediate retry. The caller keeps replay when both attempts fail.
  private async persistUsage(fs: FileSystemBackend, history: TokenUsageHistory): Promise<boolean> {
    try {
      await writeTokenUsageHistory(fs, history)
      return true
    } catch {
      try {
        await writeTokenUsageHistory(fs, history)
        return true
      } catch (error) {
        console.warn(`stride token usage: write-failed ${errorText(error)}`)
        return false
      }
    }
  }

  // The current ledger covers every replay. An older snapshot covers replays up to its revision.
  private dropReplay(revision: number, snapshot: TokenUsageHistory) {
    const covered = snapshot === this.tokenHistory ? Number.POSITIVE_INFINITY : revision
    this.pendingUsage = this.pendingUsage.filter((item) => !item.replay || item.revision > covered)
  }

  private readLegacyUsage() {
    if (typeof localStorage === 'undefined') return emptyTokenUsage()
    return parseTokenUsage(localStorage.getItem(TOKEN_USAGE_STORAGE_KEY))
  }

  /** Runtime for one saved config. A missing id uses the default config. */
  llmRuntime(configId?: string): { provider: string; model: string; baseUrl: string; apiKey: string } | null {
    const configs = this.form.llmConfigs
    const config = (configId ? configs.find((item) => item.id === configId) : undefined)
      ?? configs.find((item) => item.isDefault)
    if (!config) return null
    return {
      provider: config.provider,
      model: config.model,
      baseUrl: effectiveBaseUrl(config),
      apiKey: this.memoryLlmKeys[config.id] ?? '',
    }
  }

  devLlmBaseUrl(baseUrl: string): string {
    if (!import.meta.env.DEV || !isHttpUrl(baseUrl)) return baseUrl
    try {
      const path = llmProxyBaseUrl(baseUrl)
      const origin = globalThis.location?.origin
      return origin && origin !== 'null' ? `${origin}${path}` : baseUrl
    } catch {
      return baseUrl
    }
  }

  // Overlapping loads share one read. A later call loads again.
  // The read waits on the same chain as save.
  load(): Promise<void> {
    if (this.loadTask) return this.loadTask
    const task = this.enqueue(() => this.loadBody()).finally(() => {
      if (this.loadTask === task) this.loadTask = null
      this.loaded = true
    })
    this.loadTask = task
    return task
  }

  waitUntilLoaded(): Promise<void> {
    if (this.loaded && !this.loadTask) return Promise.resolve()
    return this.load()
  }

  // Settings panel skeleton gate: true while the first read is in flight.
  get isLoading(): boolean {
    return this.loadTask !== null
  }

  async save(): Promise<void> {
    const shot = this.captureShot()
    const after = await this.enqueue(() => this.persistShot(shot))
    if (after) await this.syncVault(after)
  }

  private captureShot(): SettingsShot {
    return {
      form: this.form,
      baseline: this.committedForm,
      embeddingKey: this.embeddingKey,
      llmKeyDrafts: this.llmKeyDrafts,
      embeddingDimText: this.embeddingDimText,
    }
  }

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.ioChain.then(job, job)
    this.ioChain = run.then(() => undefined, () => undefined)
    return run
  }

  // syncVault stays outside the chain: reopen waits on waitUntilLoaded.
  private async persistShot(shot: SettingsShot): Promise<EmbeddingRuntime | null> {
    const secrets = await this.openSecrets()
    if (!secrets) return null
    try {
      const form = mergePartitions(shot.form, shot.baseline, this.committedForm)
      const embeddingKey = resolveKey(shot.embeddingKey, this.memoryEmbeddingKey)
      const llmConfigs: LlmConfig[] = form.llmConfigs.map((config) => ({
        id: config.id,
        name: config.name,
        provider: config.provider,
        model: config.model,
        baseUrl: config.baseUrl,
        apiKey: resolveLlmKey(
          Object.prototype.hasOwnProperty.call(shot.llmKeyDrafts, config.id) ? shot.llmKeyDrafts[config.id] : undefined,
          this.memoryLlmKeys[config.id] ?? '',
        ),
        isDefault: config.isDefault,
      }))
      const settings: AppSettings = {
        embedding: {
          endpoint: form.embedding.endpoint.trim(),
          model: form.embedding.model.trim(),
          apiKey: embeddingKey,
          dim: form.embedding.dim,
        },
        llmConfigs,
        releasesUrl: form.releasesUrl,
        gitEnabled: form.gitEnabled,
        autoSyncMinutes: form.autoSyncMinutes,
        autoGitEnabled: form.autoGitEnabled,
        autoGitIdleSeconds: form.autoGitIdleSeconds,
        autoGitBlurSeconds: form.autoGitBlurSeconds,
        appearance: { ...form.appearance },
        editor: { ...form.editor },
        updates: { ...form.updates },
        privacy: { ...form.privacy },
      }
      const fs = await settingsFile()
      await writeSettings(fs, SETTINGS_FILE, settings, secrets)
      const written = await fs.readText(SETTINGS_FILE)
      const rawKeys = [embeddingKey, ...llmConfigs.map((config) => config.apiKey)].filter((key) => key)
      if (keySealContainsPlaintext(written, rawKeys)) {
        // Keep the previous sealed document. Settings are not vault files.
        throw new Error('Refusing to keep a plaintext key')
      }
      if (typeof localStorage !== 'undefined') localStorage.setItem(SETTINGS_STORAGE_KEY, written)
      this.memoryEmbeddingKey = embeddingKey
      this.memoryLlmKeys = Object.fromEntries(llmConfigs.map((config) => [config.id, config.apiKey]))
      if (this.embeddingKey === shot.embeddingKey) this.embeddingKey = ''
      if (sameJson(this.llmKeyDrafts, shot.llmKeyDrafts)) this.llmKeyDrafts = {}
      if (this.embeddingDimText === shot.embeddingDimText) {
        const parsed = parsePositiveInt(shot.embeddingDimText)
        this.embeddingDimText = parsed === null
          ? shot.embeddingDimText
          : (settings.embedding.dim > 0 ? String(settings.embedding.dim) : '')
      }
      const savedForm: PublicSettings = {
        embedding: {
          endpoint: settings.embedding.endpoint,
          model: settings.embedding.model,
          keyMask: maskSecret(embeddingKey),
          dim: settings.embedding.dim,
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
        gitEnabled: settings.gitEnabled,
        autoSyncMinutes: settings.autoSyncMinutes,
        autoGitEnabled: settings.autoGitEnabled,
        autoGitIdleSeconds: settings.autoGitIdleSeconds,
        autoGitBlurSeconds: settings.autoGitBlurSeconds,
        appearance: settings.appearance,
        editor: settings.editor,
        updates: settings.updates,
        privacy: settings.privacy,
      }
      this.committedForm = savedForm
      this.form = mergePartitions(this.form, shot.form, savedForm)
      this.notice = ''
      return this.savedRuntime(settings, embeddingKey)
    } catch (error) {
      this.notice = errorText(error)
      return null
    }
  }

  private savedRuntime(settings: AppSettings, apiKey: string): EmbeddingRuntime {
    const endpoint = canonicalEmbeddingEndpoint(settings.embedding.endpoint)
    const model = settings.embedding.model
    const dim = settings.embedding.dim
    const intended = endpoint !== '' && model !== '' && dim > 0
    const active = intended && apiKey !== ''
    return { endpoint, model, apiKey, dim, intended, active }
  }

  async testEmbedding() {
    const dim = parsePositiveInt(this.embeddingDimText)
    if (dim === null) {
      this.embeddingTestResult = 'dim'
      return
    }
    const settings: AppSettings['embedding'] = {
      endpoint: this.form.embedding.endpoint.trim(),
      model: this.form.embedding.model.trim(),
      apiKey: keyForTest(this.embeddingKey, this.memoryEmbeddingKey),
      dim,
    }
    try {
      const [vector] = await new EmbeddingClient((input, init) => globalThis.fetch(input, init)).embed(['connection test'], settings)
      if (!vector || vector.length !== dim) {
        this.embeddingTestResult = `dim:${dim}:${vector?.length ?? 0}`
        return
      }
      this.embeddingTestResult = 'ok'
    } catch (error) {
      this.embeddingTestResult = errorText(error)
    }
  }

  async testSelectedLlm() {
    const current = this.form.llmConfigs.find((config) => config.id === this.selectedLlmId)
    if (!current) {
      this.llmTestResult = 'missing'
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
    this.llmTestResult = result.ok ? 'ok' : result.error
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
        gitEnabled: settings.gitEnabled,
        autoSyncMinutes: settings.autoSyncMinutes,
        autoGitEnabled: settings.autoGitEnabled,
        autoGitIdleSeconds: settings.autoGitIdleSeconds,
        autoGitBlurSeconds: settings.autoGitBlurSeconds,
        appearance: settings.appearance,
        editor: settings.editor,
        updates: settings.updates,
        privacy: settings.privacy,
      }
      this.committedForm = this.form
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
    // A desktop WebView has IndexedDB too. The host chooses the store, not that API.
    try {
      if (isDesktopRuntime()) {
        const { tauriSecretsStore } = await import('@stride/secrets-tauri')
        return await tauriSecretsStore()
      }
      if (typeof globalThis.indexedDB === 'undefined' || !globalThis.indexedDB) return null
      return await webSecretsStore()
    } catch (error) {
      const message = errorText(error)
      if (!isDesktopRuntime() && message === 'IndexedDB is not available') return null
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
