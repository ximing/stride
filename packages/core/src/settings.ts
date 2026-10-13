import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const SEAL_KEY = crypto.createHash('sha256').update('stride-settings-v1').digest()

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

export function defaultSettingsPath(): string {
  return process.env.STRIDE_SETTINGS_PATH || path.join(os.homedir(), '.stride', 'settings.json')
}

export function maskSecret(secret: string): string {
  if (!secret) return ''
  return `••••${secret.slice(-4)}`
}

export function sealSecret(secret: string): string {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', SEAL_KEY, iv)
  const enc = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, enc]).toString('base64')
}

export function openSecret(sealed: string): string {
  if (!sealed) return ''
  const buf = Buffer.from(sealed, 'base64')
  const iv = buf.subarray(0, 12)
  const tag = buf.subarray(12, 28)
  const enc = buf.subarray(28)
  const decipher = crypto.createDecipheriv('aes-256-gcm', SEAL_KEY, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8')
}

function sealAll(settings: AppSettings): SealedSettings {
  return {
    embedding: {
      endpoint: settings.embedding.endpoint,
      model: settings.embedding.model,
      keySeal: settings.embedding.apiKey ? sealSecret(settings.embedding.apiKey) : '',
      keyMask: maskSecret(settings.embedding.apiKey),
      dim: settings.embedding.dim || 4,
    },
    llm: {
      provider: settings.llm.provider,
      model: settings.llm.model,
      baseUrl: settings.llm.baseUrl,
      keySeal: settings.llm.apiKey ? sealSecret(settings.llm.apiKey) : '',
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

export function readSettings(file = defaultSettingsPath()): AppSettings {
  if (!fs.existsSync(file)) return defaultSettings()
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<SealedSettings>
  const base = defaultSettings()
  return {
    embedding: {
      endpoint: parsed.embedding?.endpoint ?? '',
      model: parsed.embedding?.model ?? '',
      apiKey: parsed.embedding?.keySeal ? openSecret(parsed.embedding.keySeal) : '',
      dim: parsed.embedding?.dim || base.embedding.dim,
    },
    llm: {
      provider: parsed.llm?.provider ?? '',
      model: parsed.llm?.model ?? '',
      baseUrl: parsed.llm?.baseUrl ?? '',
      apiKey: parsed.llm?.keySeal ? openSecret(parsed.llm.keySeal) : '',
    },
    releasesUrl: parsed.releasesUrl ?? '',
  }
}

export function writeSettings(settings: AppSettings, file = defaultSettingsPath()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(sealAll(settings), null, 2)}\n`)
}

export function settingsContainRawKey(file: string, rawKey: string): boolean {
  if (!rawKey || !fs.existsSync(file)) return false
  return fs.readFileSync(file, 'utf8').includes(rawKey)
}
