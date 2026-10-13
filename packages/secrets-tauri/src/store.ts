import { getPassword, setPassword } from 'tauri-plugin-keyring-api'
import { PlatformError, type SecretsStore } from '@stride/platform'

// Plugin argument order is service, then user. `user` is the keychain account.
const SERVICE = 'app.stride.desktop'
const ACCOUNT = 'seal-key'
const KEY_BYTES = 32

function asBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buffer).set(bytes)
  return buffer
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]!)
  return btoa(binary)
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

// base64(iv(12) || AES-GCM ciphertext-with-tag). A seal is only that string.
class AesGcmSecretsStore implements SecretsStore {
  private readonly key: CryptoKey

  constructor(key: CryptoKey) {
    this.key = key
  }

  async seal(plaintext: string): Promise<string> {
    if (plaintext === '') return ''
    const iv = new Uint8Array(12)
    globalThis.crypto.getRandomValues(iv)
    const encoded = new TextEncoder().encode(plaintext)
    const encrypted = new Uint8Array(
      await globalThis.crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: asBuffer(iv) },
        this.key,
        asBuffer(encoded),
      ),
    )
    const packed = new Uint8Array(iv.length + encrypted.length)
    packed.set(iv, 0)
    packed.set(encrypted, iv.length)
    return encodeBase64(packed)
  }

  async open(sealed: string): Promise<string> {
    if (sealed === '') return ''
    try {
      const packed = decodeBase64(sealed)
      if (packed.length < 28) throw new Error('truncated')
      const plain = await globalThis.crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: asBuffer(packed.subarray(0, 12)) },
        this.key,
        asBuffer(packed.subarray(12)),
      )
      return new TextDecoder().decode(plain)
    } catch (error) {
      if (error instanceof PlatformError) throw error
      throw new PlatformError('io', 'Failed to open sealed secret')
    }
  }
}

function randomKeyBytes(): Uint8Array {
  const raw = new Uint8Array(KEY_BYTES)
  globalThis.crypto.getRandomValues(raw)
  return raw
}

async function importAesKey(raw: Uint8Array): Promise<CryptoKey> {
  return globalThis.crypto.subtle.importKey(
    'raw',
    asBuffer(raw),
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt'],
  )
}

function decodeKey(encoded: string): Uint8Array {
  let raw: Uint8Array
  try {
    raw = decodeBase64(encoded)
  } catch {
    throw new PlatformError('io', 'Failed to load the seal key')
  }
  if (raw.length !== KEY_BYTES) throw new PlatformError('io', 'Failed to load the seal key')
  return raw
}

async function loadOrCreateKey(): Promise<Uint8Array> {
  const existing = await getPassword(SERVICE, ACCOUNT)
  if (existing == null) {
    const raw = randomKeyBytes()
    await setPassword(SERVICE, ACCOUNT, encodeBase64(raw))
    return raw
  }
  return decodeKey(existing)
}

export async function tauriSecretsStore(): Promise<SecretsStore> {
  try {
    return new AesGcmSecretsStore(await importAesKey(await loadOrCreateKey()))
  } catch (error) {
    if (error instanceof PlatformError) throw error
    const message = error instanceof Error && error.message ? error.message : 'Failed to load the seal key'
    throw new PlatformError('io', message)
  }
}
