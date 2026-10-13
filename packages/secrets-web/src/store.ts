import { PlatformError, type SecretsStore } from '@stride/platform'

// Own database: @stride/fs-web opens `stride` for directory handles.
// Sharing that name would skip creating `secrets` or make the older open fail.
const DB_NAME = 'stride-secrets'
const DB_VERSION = 1
const STORE_NAME = 'secrets'
const KEY_NAME = 'seal-key'
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

function requireIndexedDb(): IDBFactory {
  if (!globalThis.indexedDB) throw new PlatformError('io', 'IndexedDB is not available')
  return globalThis.indexedDB
}

function openDatabase(): Promise<IDBDatabase> {
  const indexedDB = requireIndexedDb()
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = (event) => {
      event.preventDefault()
      reject(request.error ?? new Error('Failed to open IndexedDB'))
    }
  })
}

function readKey(db: IDBDatabase): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly')
    const request = tx.objectStore(STORE_NAME).get(KEY_NAME)
    request.onsuccess = () => resolve(request.result)
    request.onerror = (event) => {
      event.preventDefault()
      reject(request.error ?? new Error('Failed to read the seal key'))
    }
  })
}

function writeKey(db: IDBDatabase, raw: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    const fail = (error: unknown) => {
      if (settled) return
      settled = true
      reject(error ?? new Error('Failed to store the seal key'))
    }
    const ok = () => {
      if (settled) return
      settled = true
      resolve()
    }
    const tx = db.transaction(STORE_NAME, 'readwrite')
    tx.oncomplete = () => ok()
    tx.onerror = (event) => {
      event.preventDefault()
      fail(tx.error)
    }
    tx.onabort = () => fail(tx.error)
    const request = tx.objectStore(STORE_NAME).put(raw, KEY_NAME)
    request.onerror = (event) => {
      event.preventDefault()
      fail(request.error)
    }
  })
}

function storedKey(value: unknown): Uint8Array | null {
  if (value == null) return null
  if (!(value instanceof Uint8Array) || value.length !== KEY_BYTES) {
    throw new PlatformError('io', 'Failed to load the seal key')
  }
  return new Uint8Array(value)
}

async function loadOrCreateKey(): Promise<Uint8Array> {
  const db = await openDatabase()
  try {
    const existing = storedKey(await readKey(db))
    if (existing) return existing
    const raw = randomKeyBytes()
    await writeKey(db, raw)
    return raw
  } finally {
    db.close()
  }
}

export async function webSecretsStore(): Promise<SecretsStore> {
  try {
    return new AesGcmSecretsStore(await importAesKey(await loadOrCreateKey()))
  } catch (error) {
    if (error instanceof PlatformError) throw error
    const message = error instanceof Error && error.message ? error.message : 'Failed to load the seal key'
    throw new PlatformError('io', message)
  }
}
