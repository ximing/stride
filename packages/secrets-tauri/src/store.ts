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

// Web store layout. Desktop used to keep the raw seal key here. Ciphertext lives
// outside this database and is not deleted by the move into the keychain.
const LEGACY_DB_NAME = 'stride-secrets'
const LEGACY_STORE = 'secrets'
const LEGACY_KEY = 'seal-key'

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) return false
  }
  return true
}

function requestError(request: IDBRequest, fallback: string): Error {
  return request.error ?? new Error(fallback)
}

function openLegacyDatabase(indexedDB: IDBFactory): Promise<{ db: IDBDatabase; created: boolean }> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(LEGACY_DB_NAME)
    let created = false
    request.onupgradeneeded = () => {
      created = true
    }
    request.onsuccess = () => resolve({ db: request.result, created })
    request.onerror = (event) => {
      event.preventDefault()
      reject(requestError(request, 'Failed to open IndexedDB'))
    }
  })
}

function readLegacyRecord(db: IDBDatabase): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const request = db.transaction(LEGACY_STORE, 'readonly').objectStore(LEGACY_STORE).get(LEGACY_KEY)
    request.onsuccess = () => resolve(request.result)
    request.onerror = (event) => {
      event.preventDefault()
      reject(requestError(request, 'Failed to read the seal key'))
    }
  })
}

function deleteLegacyRecord(db: IDBDatabase): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    const fail = (error: unknown) => {
      if (settled) return
      settled = true
      reject(error instanceof Error ? error : new Error('Failed to remove the old seal key'))
    }
    const ok = () => {
      if (settled) return
      settled = true
      resolve()
    }
    const tx = db.transaction(LEGACY_STORE, 'readwrite')
    tx.oncomplete = () => ok()
    tx.onerror = (event) => {
      event.preventDefault()
      fail(tx.error ?? new Error('Failed to remove the old seal key'))
    }
    tx.onabort = () => fail(tx.error ?? new Error('Failed to remove the old seal key'))
    const request = tx.objectStore(LEGACY_STORE).delete(LEGACY_KEY)
    request.onerror = (event) => {
      event.preventDefault()
      fail(requestError(request, 'Failed to remove the old seal key'))
    }
  })
}

// A versionless open creates an empty database when none exists. Drop that probe
// only. A failure here must not block creating a keychain key.
function discardCreatedDatabase(indexedDB: IDBFactory): Promise<void> {
  return new Promise((resolve) => {
    const request = indexedDB.deleteDatabase(LEGACY_DB_NAME)
    request.onsuccess = () => resolve()
    request.onerror = () => resolve()
    request.onblocked = () => resolve()
  })
}

async function readLegacySealKey(): Promise<Uint8Array | null> {
  const indexedDB = globalThis.indexedDB
  if (!indexedDB) return null
  if (typeof indexedDB.databases === 'function') {
    const listed = await indexedDB.databases()
    if (!listed.some((entry) => entry.name === LEGACY_DB_NAME)) return null
  }
  const opened = await openLegacyDatabase(indexedDB)
  const dropEmptyProbe = opened.created && !opened.db.objectStoreNames.contains(LEGACY_STORE)
  try {
    if (!opened.db.objectStoreNames.contains(LEGACY_STORE)) return null
    const value = await readLegacyRecord(opened.db)
    if (value == null) return null
    if (!(value instanceof Uint8Array) || value.length !== KEY_BYTES) {
      throw new PlatformError('io', 'Failed to load the seal key')
    }
    return new Uint8Array(value)
  } finally {
    opened.db.close()
    // Only a database this probe just created, and only when it has no seal store.
    if (dropEmptyProbe) await discardCreatedDatabase(indexedDB)
  }
}

async function removeLegacySealKey(): Promise<void> {
  const indexedDB = globalThis.indexedDB
  if (!indexedDB) throw new PlatformError('io', 'Failed to remove the old seal key')
  const opened = await openLegacyDatabase(indexedDB)
  try {
    if (opened.created || !opened.db.objectStoreNames.contains(LEGACY_STORE)) return
    await deleteLegacyRecord(opened.db)
  } finally {
    opened.db.close()
    if (opened.created) await discardCreatedDatabase(indexedDB)
  }
}

// Shared by concurrent first opens so only one seal key is written.
let sealKeyInflight: Promise<Uint8Array> | null = null

function loadOrCreateKey(): Promise<Uint8Array> {
  if (!sealKeyInflight) {
    sealKeyInflight = loadOrCreateKeyBody().finally(() => {
      sealKeyInflight = null
    })
  }
  return sealKeyInflight
}

async function loadOrCreateKeyBody(): Promise<Uint8Array> {
  const existing = await getPassword(SERVICE, ACCOUNT)
  const legacy = await readLegacySealKey()
  if (existing != null) {
    const raw = decodeKey(existing)
    if (legacy) {
      if (!sameBytes(legacy, raw)) {
        throw new PlatformError('io', 'Failed to move the seal key into the keychain')
      }
      await removeLegacySealKey()
    }
    return raw
  }
  if (legacy) {
    await setPassword(SERVICE, ACCOUNT, encodeBase64(legacy))
    await removeLegacySealKey()
    return legacy
  }
  const raw = randomKeyBytes()
  await setPassword(SERVICE, ACCOUNT, encodeBase64(raw))
  return raw
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
