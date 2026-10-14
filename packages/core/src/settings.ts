import type { FileSystemBackend, SecretsStore } from '@stride/platform'
import { effectiveBaseUrl, type LlmConfig } from './llm.ts'
import { isLlmProvider } from './llm-catalog.ts'

export interface EmbeddingSettings {
  endpoint: string
  model: string
  apiKey: string
  dim: number
}

export interface LlmSettings {
  provider: string
  model: string
  baseUrl: string
  apiKey: string
}

export interface AppSettings {
  embedding: EmbeddingSettings
  llmConfigs: LlmConfig[]
  releasesUrl: string
  gitEnabled: boolean
  autoSyncMinutes: number
  autoGitEnabled: boolean
  autoGitIdleSeconds: number
  autoGitBlurSeconds: number
}

interface SealedLlmConfig {
  id: string
  name: string
  provider: string
  model: string
  baseUrl: string
  keySeal: string
  keyMask: string
  isDefault: boolean
}

interface SealedSettings {
  embedding: { endpoint: string; model: string; keySeal: string; keyMask: string; dim: number }
  llmConfigs: SealedLlmConfig[]
  releasesUrl: string
  gitEnabled: boolean
  autoSyncMinutes: number
  autoGitEnabled: boolean
  autoGitIdleSeconds: number
  autoGitBlurSeconds: number
}

interface ParsedLlmConfig {
  id?: string
  name?: string
  provider?: string
  model?: string
  baseUrl?: string
  keySeal?: string
  keyMask?: string
  isDefault?: boolean
}

interface ParsedSettings {
  embedding?: { endpoint?: string; model?: string; keySeal?: string; keyMask?: string; dim?: number }
  llmConfigs?: ParsedLlmConfig[]
  llm?: { provider?: string; model?: string; baseUrl?: string; keySeal?: string; keyMask?: string }
  releasesUrl?: string
  gitEnabled?: unknown
  autoSyncMinutes?: unknown
  autoGitEnabled?: unknown
  autoGitIdleSeconds?: unknown
  autoGitBlurSeconds?: unknown
}

export interface PublicLlmConfig {
  id: string
  name: string
  provider: string
  model: string
  baseUrl: string
  keyMask: string
  isDefault: boolean
}

export function normalizeAutoSyncMinutes(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 0
  return value
}

export function normalizeAutoGitSeconds(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 0
  return value
}

export function defaultSettings(): AppSettings {
  return {
    embedding: { endpoint: '', model: '', apiKey: '', dim: 4 },
    llmConfigs: [],
    releasesUrl: '',
    gitEnabled: true,
    autoSyncMinutes: 0,
    autoGitEnabled: false,
    autoGitIdleSeconds: 0,
    autoGitBlurSeconds: 0,
  }
}

export function defaultSettingsPath(homeDir: string, override = ''): string {
  if (override) return override
  const home = homeDir.replace(/[\\/]+$/, '')
  return `${home}/.stride/settings.json`
}

export function maskSecret(secret: string): string {
  if (!secret) return ''
  return `••••${secret.slice(-4)}`
}

export async function sealSecret(secrets: SecretsStore, secret: string): Promise<string> {
  return secrets.seal(secret)
}

export async function openSecret(secrets: SecretsStore, sealed: string): Promise<string> {
  return secrets.open(sealed)
}

// Missing or non-integer dims stay at the historical default. Explicit 0 means
// "no real embedding width" and must not be rewritten to 4.
function normalizeEmbeddingDim(value: number | undefined, fallback = 4): number {
  if (value === 0) return 0
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value
  return fallback
}

function singleDefault(configs: LlmConfig[]): LlmConfig[] {
  let taken = false
  return configs.map((config) => {
    if (!config.isDefault) return config
    if (taken) return { ...config, isDefault: false }
    taken = true
    return config
  })
}

function textField(value: string | undefined): string {
  return typeof value === 'string' ? value : ''
}

async function openLlmConfigs(parsed: ParsedSettings, secrets: SecretsStore): Promise<LlmConfig[]> {
  if (Array.isArray(parsed.llmConfigs)) {
    const configs = await Promise.all(parsed.llmConfigs.map(async (item, index) => ({
      id: typeof item?.id === 'string' && item.id.trim() ? item.id : `legacy-${index}`,
      name: textField(item?.name),
      provider: textField(item?.provider),
      model: textField(item?.model),
      baseUrl: textField(item?.baseUrl),
      apiKey: item?.keySeal ? await secrets.open(item.keySeal) : '',
      isDefault: item?.isDefault === true,
    })))
    return singleDefault(configs)
  }
  if (parsed.llm && typeof parsed.llm === 'object') {
    const legacy = parsed.llm
    const provider = typeof legacy.provider === 'string' && isLlmProvider(legacy.provider) ? legacy.provider : 'custom'
    return [{
      id: 'legacy',
      name: 'LLM',
      provider,
      model: textField(legacy.model),
      baseUrl: textField(legacy.baseUrl),
      apiKey: legacy.keySeal ? await secrets.open(legacy.keySeal) : '',
      isDefault: true,
    }]
  }
  return []
}

async function sealAll(secrets: SecretsStore, settings: AppSettings): Promise<SealedSettings> {
  const llmConfigs = singleDefault(settings.llmConfigs)
  return {
    embedding: {
      endpoint: settings.embedding.endpoint,
      model: settings.embedding.model,
      keySeal: settings.embedding.apiKey ? await secrets.seal(settings.embedding.apiKey) : '',
      keyMask: maskSecret(settings.embedding.apiKey),
      dim: normalizeEmbeddingDim(settings.embedding.dim),
    },
    llmConfigs: await Promise.all(llmConfigs.map(async (config) => ({
      id: config.id,
      name: config.name,
      provider: config.provider,
      model: config.model,
      baseUrl: config.baseUrl,
      keySeal: config.apiKey ? await secrets.seal(config.apiKey) : '',
      keyMask: maskSecret(config.apiKey),
      isDefault: config.isDefault,
    }))),
    releasesUrl: settings.releasesUrl,
    gitEnabled: settings.gitEnabled !== false,
    autoSyncMinutes: normalizeAutoSyncMinutes(settings.autoSyncMinutes),
    autoGitEnabled: settings.autoGitEnabled === true,
    autoGitIdleSeconds: normalizeAutoGitSeconds(settings.autoGitIdleSeconds),
    autoGitBlurSeconds: normalizeAutoGitSeconds(settings.autoGitBlurSeconds),
  }
}

export function publicSettings(settings: AppSettings): {
  embedding: { endpoint: string; model: string; keyMask: string; dim: number }
  llmConfigs: PublicLlmConfig[]
  releasesUrl: string
  gitEnabled: boolean
  autoSyncMinutes: number
  autoGitEnabled: boolean
  autoGitIdleSeconds: number
  autoGitBlurSeconds: number
} {
  return {
    embedding: {
      endpoint: settings.embedding.endpoint,
      model: settings.embedding.model,
      keyMask: maskSecret(settings.embedding.apiKey),
      dim: normalizeEmbeddingDim(settings.embedding.dim),
    },
    llmConfigs: singleDefault(settings.llmConfigs).map((config) => ({
      id: config.id,
      name: config.name,
      provider: config.provider,
      model: config.model,
      baseUrl: config.baseUrl,
      keyMask: maskSecret(config.apiKey),
      isDefault: config.isDefault,
    })),
    releasesUrl: settings.releasesUrl,
    gitEnabled: settings.gitEnabled !== false,
    autoSyncMinutes: normalizeAutoSyncMinutes(settings.autoSyncMinutes),
    autoGitEnabled: settings.autoGitEnabled === true,
    autoGitIdleSeconds: normalizeAutoGitSeconds(settings.autoGitIdleSeconds),
    autoGitBlurSeconds: normalizeAutoGitSeconds(settings.autoGitBlurSeconds),
  }
}

export function defaultLlmConfig(settings: AppSettings): LlmConfig | null {
  return singleDefault(settings.llmConfigs).find((config) => config.isDefault) ?? null
}

export function defaultLlmSettings(settings: AppSettings): LlmSettings | null {
  const config = defaultLlmConfig(settings)
  if (!config) return null
  return {
    provider: config.provider,
    model: config.model,
    baseUrl: effectiveBaseUrl(config),
    apiKey: config.apiKey,
  }
}

export async function readSettings(
  fs: FileSystemBackend,
  file: string,
  secrets: SecretsStore,
): Promise<AppSettings> {
  if (!(await fs.stat(file))) return defaultSettings()
  const parsed = JSON.parse(await fs.readText(file)) as ParsedSettings
  const base = defaultSettings()
  return {
    embedding: {
      endpoint: parsed.embedding?.endpoint ?? '',
      model: parsed.embedding?.model ?? '',
      apiKey: parsed.embedding?.keySeal ? await secrets.open(parsed.embedding.keySeal) : '',
      dim: normalizeEmbeddingDim(parsed.embedding?.dim, base.embedding.dim),
    },
    llmConfigs: await openLlmConfigs(parsed, secrets),
    releasesUrl: parsed.releasesUrl ?? '',
    gitEnabled: parsed.gitEnabled !== false,
    autoSyncMinutes: normalizeAutoSyncMinutes(parsed.autoSyncMinutes),
    autoGitEnabled: parsed.autoGitEnabled === true,
    autoGitIdleSeconds: normalizeAutoGitSeconds(parsed.autoGitIdleSeconds),
    autoGitBlurSeconds: normalizeAutoGitSeconds(parsed.autoGitBlurSeconds),
  }
}

export async function writeSettings(
  fs: FileSystemBackend,
  file: string,
  settings: AppSettings,
  secrets: SecretsStore,
): Promise<void> {
  await fs.writeText(file, `${JSON.stringify(await sealAll(secrets, settings), null, 2)}\n`)
}

export async function settingsContainRawKey(
  fs: FileSystemBackend,
  file: string,
  rawKey: string,
): Promise<boolean> {
  if (!rawKey || !(await fs.stat(file))) return false
  return (await fs.readText(file)).includes(rawKey)
}
