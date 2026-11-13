import { execFile as nodeExecFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { assertTrustedSender, type RendererTrust } from './security.ts'

/**
 * Seal key file in app userData, never a vault path.
 * Every platform stores safeStorage ciphertext of the 32-byte base64 key.
 */
export const SEAL_KEY_FILE_NAME = 'seal-key.bin'

const KEY_BYTES = 32
const KEYCHAIN_SERVICE = 'app.stride.desktop'
const KEYCHAIN_ACCOUNT = 'seal-key'

export interface HostSafeStorage {
  isEncryptionAvailable(): boolean
  encryptString(plainText: string): Buffer
  decryptString(encrypted: Buffer): string
}

export interface HostSecretsEvent {
  sender: { getURL(): string }
}

export interface HostExecResult {
  stdout: string
  stderr: string
}

export type HostSecurityExec = (file: string, args: readonly string[]) => Promise<HostExecResult>

export interface HostSecretsDeps {
  handle(channel: string, listener: (event: HostSecretsEvent, payload?: unknown) => unknown): void
  getTrust(): RendererTrust
  userDataPath(): string
  safeStorage: HostSafeStorage
  platform?: NodeJS.Platform
  execFile?: HostSecurityExec
}

function isEnoent(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'ENOENT'
}

function rejectInvalid(): never {
  throw new Error('Rejected invalid seal key request')
}

function readLegacy(payload: unknown): string | null {
  if (payload == null) return null
  if (typeof payload !== 'object' || Array.isArray(payload)) rejectInvalid()
  const record = payload as Record<string, unknown>
  const keys = Object.keys(record)
  if (keys.length === 0) return null
  if (keys.length !== 1 || keys[0] !== 'legacy' || !('legacy' in record)) rejectInvalid()
  const legacy = record.legacy
  if (legacy == null) return null
  if (typeof legacy !== 'string' || legacy.length === 0 || legacy.length > 128) rejectInvalid()
  return legacy
}

function decodeKey(encoded: string): Buffer {
  const raw = Buffer.from(encoded, 'base64')
  if (raw.length !== KEY_BYTES || raw.toString('base64') !== encoded) {
    throw new Error('Failed to load the seal key')
  }
  return raw
}

function isCanonicalKeyText(encoded: string): boolean {
  const raw = Buffer.from(encoded, 'base64')
  return raw.length === KEY_BYTES && raw.toString('base64') === encoded
}

function sealKeyPath(userData: string): string {
  return join(userData, SEAL_KEY_FILE_NAME)
}

function platformOf(deps: HostSecretsDeps): NodeJS.Platform {
  return deps.platform ?? process.platform
}

async function readStored(path: string, safeStorage: HostSafeStorage): Promise<string | null> {
  let bytes: Buffer
  try {
    bytes = await readFile(path)
  } catch (error) {
    if (isEnoent(error)) return null
    throw new Error('Failed to load the seal key')
  }
  // Some safeStorage builds return unprefixed bytes unchanged. Reject a usable
  // plaintext key before decrypt so that compatibility path cannot load it.
  if (isCanonicalKeyText(bytes.toString('utf8'))) {
    throw new Error('Failed to load the seal key')
  }
  try {
    const encoded = safeStorage.decryptString(bytes)
    decodeKey(encoded)
    return encoded
  } catch {
    throw new Error('Failed to load the seal key')
  }
}

async function writeStored(
  userData: string,
  path: string,
  safeStorage: HostSafeStorage,
  encoded: string,
): Promise<void> {
  const payload = safeStorage.encryptString(encoded)
  await mkdir(userData, { recursive: true, mode: 0o700 })
  const tmp = `${path}.${process.pid}.tmp`
  try {
    await writeFile(tmp, payload, { mode: 0o600 })
    await chmod(tmp, 0o600)
    await rename(tmp, path)
    await chmod(path, 0o600)
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined)
    throw error instanceof Error && error.message ? error : new Error('Failed to load the seal key')
  }
}

function defaultExecFile(file: string, args: readonly string[]): Promise<HostExecResult> {
  return new Promise((resolve, reject) => {
    nodeExecFile(file, args, { encoding: 'utf8', windowsHide: true, timeout: 5000 }, (error, stdout, stderr) => {
      if (error) {
        reject(error)
        return
      }
      resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
    })
  })
}

/** Best-effort macOS keychain read. Failure returns null and never includes command output. */
async function readMacKeychain(execFile: HostSecurityExec): Promise<string | null> {
  try {
    const { stdout } = await execFile('security', [
      'find-generic-password',
      '-s',
      KEYCHAIN_SERVICE,
      '-a',
      KEYCHAIN_ACCOUNT,
      '-w',
    ])
    const encoded = stdout.replace(/\r?\n$/, '')
    decodeKey(encoded)
    return encoded
  } catch {
    return null
  }
}

interface LegacySlot {
  legacy: string | null
  conflict: boolean
}

async function getOrCreateBody(deps: HostSecretsDeps, slot: LegacySlot): Promise<string> {
  if (!deps.safeStorage.isEncryptionAvailable()) {
    throw new Error('Safe storage is unavailable')
  }
  const path = sealKeyPath(deps.userDataPath())
  const existing = await readStored(path, deps.safeStorage)
  if (existing != null) return existing
  if (slot.conflict) throw new Error('Rejected conflicting seal key legacy')
  const platform = platformOf(deps)
  let next = slot.legacy
  if (!next && platform === 'darwin') {
    next = await readMacKeychain(deps.execFile ?? defaultExecFile)
  }
  if (slot.conflict) throw new Error('Rejected conflicting seal key legacy')
  if (slot.legacy) next = slot.legacy
  if (!next) next = randomBytes(KEY_BYTES).toString('base64')
  const chosen = next
  await writeStored(deps.userDataPath(), path, deps.safeStorage, chosen)
  return chosen
}

export function registerHostSecrets(deps: HostSecretsDeps): void {
  let inflight: Promise<string> | null = null
  let slot: LegacySlot | null = null
  deps.handle('secrets:getOrCreateKey', (event, payload) => {
    assertTrustedSender(event, deps.getTrust())
    const legacy = readLegacy(payload)
    if (legacy) decodeKey(legacy)
    if (!inflight || !slot) {
      const current: LegacySlot = { legacy, conflict: false }
      slot = current
      inflight = getOrCreateBody(deps, current).finally(() => {
        inflight = null
        slot = null
      })
    } else if (legacy) {
      if (slot.legacy && slot.legacy !== legacy) slot.conflict = true
      else slot.legacy = legacy
    }
    const pending = inflight
    return pending.then((value) => {
      if (legacy && legacy !== value) {
        throw new Error('Failed to move the seal key into the keychain')
      }
      return value
    })
  })
}
