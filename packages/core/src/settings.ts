import type { FileSystemBackend, SecretsStore } from '@stride/platform'

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
  llm: LlmSettings
  releasesUrl: string
}

interface SealedSettings {
  embedding: { endpoint: string; model: string; keySeal: string; keyMask: string; dim: number }
  llm: { provider: string; model: string; baseUrl: string; keySeal: string; keyMask: string }
  releasesUrl: string
}

export function defaultSettings(): AppSettings {
  return {
    embedding: { endpoint: '', model: '', apiKey: '', dim: 4 },
    llm: { provider: '', model: '', baseUrl: '', apiKey: '' },
    releasesUrl: '',
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

async function sealAll(secrets: SecretsStore, settings: AppSettings): Promise<SealedSettings> {
  return {
    embedding: {
      endpoint: settings.embedding.endpoint,
      model: settings.embedding.model,
      keySeal: settings.embedding.apiKey ? await secrets.seal(settings.embedding.apiKey) : '',
      keyMask: maskSecret(settings.embedding.apiKey),
      dim: settings.embedding.dim || 4,
    },
    llm: {
      provider: settings.llm.provider,
      model: settings.llm.model,
      baseUrl: settings.llm.baseUrl,
      keySeal: settings.llm.apiKey ? await secrets.seal(settings.llm.apiKey) : '',
      keyMask: maskSecret(settings.llm.apiKey),
    },
    releasesUrl: settings.releasesUrl,
  }
}

export function publicSettings(settings: AppSettings): {
  embedding: { endpoint: string; model: string; keyMask: string; dim: number }
  llm: { provider: string; model: string; baseUrl: string; keyMask: string }
  releasesUrl: string
} {
  return {
    embedding: {
      endpoint: settings.embedding.endpoint,
      model: settings.embedding.model,
      keyMask: maskSecret(settings.embedding.apiKey),
      dim: settings.embedding.dim || 4,
    },
    llm: {
      provider: settings.llm.provider,
      model: settings.llm.model,
      baseUrl: settings.llm.baseUrl,
      keyMask: maskSecret(settings.llm.apiKey),
    },
    releasesUrl: settings.releasesUrl,
  }
}

export async function readSettings(
  fs: FileSystemBackend,
  file: string,
  secrets: SecretsStore,
): Promise<AppSettings> {
  if (!(await fs.stat(file))) return defaultSettings()
  const parsed = JSON.parse(await fs.readText(file)) as Partial<SealedSettings>
  const base = defaultSettings()
  return {
    embedding: {
      endpoint: parsed.embedding?.endpoint ?? '',
      model: parsed.embedding?.model ?? '',
      apiKey: parsed.embedding?.keySeal ? await secrets.open(parsed.embedding.keySeal) : '',
      dim: parsed.embedding?.dim || base.embedding.dim,
    },
    llm: {
      provider: parsed.llm?.provider ?? '',
      model: parsed.llm?.model ?? '',
      baseUrl: parsed.llm?.baseUrl ?? '',
      apiKey: parsed.llm?.keySeal ? await secrets.open(parsed.llm.keySeal) : '',
    },
    releasesUrl: parsed.releasesUrl ?? '',
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
