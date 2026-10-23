import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import indexSource from './index.ts?raw'
import storeSource from './store.ts?raw'
import * as api from './index.ts'

const keyring = vi.hoisted(() => {
  const entries = new Map<string, string>()
  const calls: string[] = []
  const id = (service: string, user: string) => `${service}\0${user}`
  const api = {
    entries,
    calls,
    failSet: null as string | null,
    holdSet: null as Promise<void> | null,
    onSet: null as (() => void) | null,
    reset() {
      entries.clear()
      calls.length = 0
      api.failSet = null
      api.holdSet = null
      api.onSet = null
    },
    async getPassword(service: string, user: string): Promise<string | null> {
      calls.push(`get ${service} ${user}`)
      return entries.get(id(service, user)) ?? null
    },
    async setPassword(service: string, user: string, password: string): Promise<void> {
      calls.push(`set ${service} ${user}`)
      api.onSet?.()
      if (api.holdSet) await api.holdSet
      if (api.failSet) throw new Error(api.failSet)
      entries.set(id(service, user), password)
    },
  }
  return api
})

vi.mock('tauri-plugin-keyring-api', () => ({
  getPassword: (service: string, user: string) => keyring.getPassword(service, user),
  setPassword: (service: string, user: string, password: string) => keyring.setPassword(service, user, password),
}))

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

function copyBytes(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buffer).set(bytes)
  return buffer
}

function storedPassword(): string {
  const value = keyring.entries.get('app.stride.desktop\0seal-key')
  if (value == null) throw new Error('seal key was not stored')
  return value
}

async function decryptLayout(rawKey: Uint8Array, sealed: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', copyBytes(rawKey), { name: 'AES-GCM' }, false, ['decrypt'])
  const packed = decodeBase64(sealed)
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: copyBytes(packed.subarray(0, 12)) },
    key,
    copyBytes(packed.subarray(12)),
  )
  return new TextDecoder().decode(plain)
}

describe('tauriSecretsStore', () => {
  beforeEach(() => {
    keyring.reset()
  })

  it('seals and opens an empty string as empty', async () => {
    const store = await api.tauriSecretsStore()
    expect(await store.seal('')).toBe('')
    expect(await store.open('')).toBe('')
  })

  it('round-trips a non-empty string as base64 of iv and ciphertext-with-tag', async () => {
    const store = await api.tauriSecretsStore()
    const sealed = await store.seal('sk-live-secret')
    expect(sealed).toMatch(/^[A-Za-z0-9+/]+={0,2}$/)
    expect(sealed).not.toBe('sk-live-secret')
    const packed = decodeBase64(sealed)
    expect(packed.length).toBe(12 + new TextEncoder().encode('sk-live-secret').length + 16)
    expect(await store.open(sealed)).toBe('sk-live-secret')
    const raw = decodeBase64(storedPassword())
    expect(raw).toHaveLength(32)
    expect(await decryptLayout(raw, sealed)).toBe('sk-live-secret')
  })

  it('opens a seal from a second instance that reads the same key', async () => {
    const first = await api.tauriSecretsStore()
    const sealed = await first.seal('shared-secret')
    const persisted = storedPassword()
    keyring.calls.length = 0
    const second = await api.tauriSecretsStore()
    expect(second).not.toBe(first)
    expect(keyring.calls).toEqual(['get app.stride.desktop seal-key'])
    expect(storedPassword()).toBe(persisted)
    expect(await second.open(sealed)).toBe('shared-secret')
    expect(await first.open(sealed)).toBe('shared-secret')
  })

  it('fails open with io when the keychain key is different', async () => {
    const store = await api.tauriSecretsStore()
    const sealed = await store.seal('top-secret')
    const other = new Uint8Array(32)
    other[0] = 9
    keyring.entries.set('app.stride.desktop\0seal-key', encodeBase64(other))
    const mismatched = await api.tauriSecretsStore()
    await expect(mismatched.open(sealed)).rejects.toMatchObject({ name: 'PlatformError', code: 'io' })
    expect(await store.open(sealed)).toBe('top-secret')
  })

  it('stores a random 32-byte key as base64 under the desktop service account', async () => {
    await api.tauriSecretsStore()
    expect(keyring.calls).toEqual([
      'get app.stride.desktop seal-key',
      'set app.stride.desktop seal-key',
    ])
    const raw = decodeBase64(storedPassword())
    expect(raw).toHaveLength(32)
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('stride-settings-v1')))
    expect(raw).not.toEqual(digest)
    expect(storedPassword()).not.toBe('stride-settings-v1')
  })

  it('does not reimplement maskSecret', () => {
    const source = `${indexSource}\n${storeSource}`
    expect(source).not.toContain('maskSecret')
    expect(source).not.toContain('••••')
    expect(source).not.toContain('stride-settings-v1')
    expect(source).not.toContain('deriveKey')
    expect(Object.keys(api).sort()).toEqual(['tauriSecretsStore'])
    expect(api).not.toHaveProperty('maskSecret')
  })
})

interface FakeRequest {
  result: unknown
  error: DOMException | null
  onsuccess: ((event: Event) => void) | null
  onerror: ((event: Event) => void) | null
  onupgradeneeded: ((event: Event) => void) | null
  onblocked: ((event: Event) => void) | null
}

function makeRequest(): FakeRequest {
  return {
    result: undefined,
    error: null,
    onsuccess: null,
    onerror: null,
    onupgradeneeded: null,
    onblocked: null,
  }
}

class LegacyIndexedDb {
  readonly databases = new Map<string, Map<string, Map<string, unknown>>>()
  opens: string[] = []
  databaseDeletes: string[] = []
  failRecordDelete = false
  listDatabases = true

  seed(dbName: string, storeName: string, records: Record<string, unknown>): void {
    let db = this.databases.get(dbName)
    if (!db) {
      db = new Map()
      this.databases.set(dbName, db)
    }
    const store = new Map<string, unknown>()
    for (const [key, value] of Object.entries(records)) {
      store.set(key, value instanceof Uint8Array ? new Uint8Array(value) : value)
    }
    db.set(storeName, store)
  }

  sealKey(): Uint8Array | undefined {
    const value = this.databases.get('stride-secrets')?.get('secrets')?.get('seal-key')
    return value instanceof Uint8Array ? value : undefined
  }

  install(options?: { databases?: boolean }): void {
    const self = this
    const idb = {
      databases: async () => {
        if (!self.listDatabases) throw new Error('databases unavailable')
        return [...self.databases.keys()].map((name) => ({ name, version: 1 }))
      },
      open: (name: string) => {
        self.opens.push(name)
        const request = makeRequest()
        queueMicrotask(() => {
          let db = self.databases.get(name)
          const created = !db
          if (!db) {
            db = new Map()
            self.databases.set(name, db)
          }
          request.result = self.database(db)
          if (created) request.onupgradeneeded?.(new Event('upgradeneeded'))
          request.onsuccess?.(new Event('success'))
        })
        return request
      },
      deleteDatabase: (name: string) => {
        self.databaseDeletes.push(name)
        const request = makeRequest()
        queueMicrotask(() => {
          self.databases.delete(name)
          request.onsuccess?.(new Event('success'))
        })
        return request
      },
    }
    if (options?.databases === false) {
      delete (idb as { databases?: unknown }).databases
    }
    globalThis.indexedDB = idb as unknown as IDBFactory
  }

  private database(stores: Map<string, Map<string, unknown>>) {
    const self = this
    return {
      objectStoreNames: {
        contains: (name: string) => stores.has(name),
      },
      transaction: (storeName: string) => {
        const store = stores.get(storeName)
        if (!store) throw new DOMException(`No object store named ${storeName}`, 'NotFoundError')
        return self.transaction(store)
      },
      close: () => {},
    }
  }

  private transaction(store: Map<string, unknown>) {
    const self = this
    let completed = false
    const tx = {
      error: null as DOMException | null,
      oncomplete: null as ((event: Event) => void) | null,
      onerror: null as ((event: Event) => void) | null,
      onabort: null as ((event: Event) => void) | null,
      objectStore: () => ({
        get: (key: string) => {
          const request = makeRequest()
          queueMicrotask(() => {
            const value = store.get(key)
            request.result = value instanceof Uint8Array ? new Uint8Array(value) : value
            request.onsuccess?.(new Event('success'))
            finish()
          })
          return request
        },
        delete: (key: string) => {
          const request = makeRequest()
          queueMicrotask(() => {
            if (self.failRecordDelete) {
              const error = new DOMException('delete failed', 'UnknownError')
              request.error = error
              tx.error = error
              request.onerror?.(new Event('error', { cancelable: true }))
              tx.onabort?.(new Event('abort'))
              return
            }
            store.delete(key)
            request.onsuccess?.(new Event('success'))
            finish()
          })
          return request
        },
      }),
    }
    const finish = () => {
      if (completed) return
      completed = true
      queueMicrotask(() => {
        tx.oncomplete?.(new Event('complete'))
      })
    }
    return tx
  }
}

function legacyKey(): Uint8Array {
  const raw = new Uint8Array(32)
  raw[0] = 7
  raw[31] = 3
  return raw
}

const CIPHERTEXT_KEY = 'stride:settings'

function installCiphertext(value: string): { removes: string[] } {
  const values = new Map<string, string>([[CIPHERTEXT_KEY, value]])
  const removes: string[] = []
  globalThis.localStorage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, next: string) => {
      values.set(key, next)
    },
    removeItem: (key: string) => {
      removes.push(key)
      values.delete(key)
    },
    clear: () => {
      values.clear()
    },
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() {
      return values.size
    },
  } as Storage
  return { removes }
}

async function encryptLayout(rawKey: Uint8Array, plaintext: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', copyBytes(rawKey), { name: 'AES-GCM' }, false, ['encrypt'])
  const iv = new Uint8Array(12)
  crypto.getRandomValues(iv)
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: copyBytes(iv) },
      key,
      copyBytes(new TextEncoder().encode(plaintext)),
    ),
  )
  const packed = new Uint8Array(iv.length + encrypted.length)
  packed.set(iv, 0)
  packed.set(encrypted, iv.length)
  return encodeBase64(packed)
}

describe('legacy web seal key', () => {
  let idb: LegacyIndexedDb
  let ciphertext: { removes: string[] }

  beforeEach(() => {
    keyring.reset()
    idb = new LegacyIndexedDb()
    idb.install()
    ciphertext = installCiphertext('sealed-settings-v1')
  })

  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'indexedDB')
    Reflect.deleteProperty(globalThis, 'localStorage')
  })

  it('moves the IndexedDB seal key into the keychain and only then removes it', async () => {
    const legacy = legacyKey()
    idb.seed('stride-secrets', 'secrets', { 'seal-key': legacy, 'other-key': 'keep' })
    idb.seed('stride', 'fs-handles', { 'vault-directory': { kind: 'directory' } })
    const sealed = await encryptLayout(legacy, 'sk-old')
    let presentDuringWrite = false
    keyring.onSet = () => {
      presentDuringWrite = Boolean(idb.sealKey())
    }
    const store = await api.tauriSecretsStore()
    expect(presentDuringWrite).toBe(true)
    expect(idb.sealKey()).toBeUndefined()
    expect(idb.databases.get('stride-secrets')?.get('secrets')?.get('other-key')).toBe('keep')
    expect(idb.databases.get('stride')?.get('fs-handles')?.get('vault-directory')).toEqual({ kind: 'directory' })
    expect(idb.databaseDeletes).toEqual([])
    expect(decodeBase64(storedPassword())).toEqual(legacy)
    expect(await store.open(sealed)).toBe('sk-old')
    expect(globalThis.localStorage.getItem(CIPHERTEXT_KEY)).toBe('sealed-settings-v1')
    expect(ciphertext.removes).toEqual([])
  })

  it('leaves the IndexedDB seal key and ciphertext when the keychain write fails', async () => {
    const legacy = legacyKey()
    idb.seed('stride-secrets', 'secrets', { 'seal-key': legacy })
    keyring.failSet = 'keychain unavailable'
    let presentDuringWrite = false
    keyring.onSet = () => {
      presentDuringWrite = Boolean(idb.sealKey())
    }
    await expect(api.tauriSecretsStore()).rejects.toMatchObject({
      name: 'PlatformError',
      code: 'io',
      message: 'keychain unavailable',
    })
    expect(presentDuringWrite).toBe(true)
    expect(idb.sealKey()).toEqual(legacy)
    expect(keyring.entries.has('app.stride.desktop\0seal-key')).toBe(false)
    expect(globalThis.localStorage.getItem(CIPHERTEXT_KEY)).toBe('sealed-settings-v1')
    expect(ciphertext.removes).toEqual([])
  })

  it('leaves the IndexedDB seal key when removing it fails after the keychain write', async () => {
    const legacy = legacyKey()
    idb.seed('stride-secrets', 'secrets', { 'seal-key': legacy })
    idb.failRecordDelete = true
    await expect(api.tauriSecretsStore()).rejects.toMatchObject({ name: 'PlatformError', code: 'io' })
    expect(idb.sealKey()).toEqual(legacy)
    expect(decodeBase64(storedPassword())).toEqual(legacy)
    expect(globalThis.localStorage.getItem(CIPHERTEXT_KEY)).toBe('sealed-settings-v1')
    expect(ciphertext.removes).toEqual([])
  })

  it('does not overwrite a different keychain key or delete IndexedDB', async () => {
    const legacy = legacyKey()
    const other = new Uint8Array(32)
    other[0] = 9
    idb.seed('stride-secrets', 'secrets', { 'seal-key': legacy })
    keyring.entries.set('app.stride.desktop\0seal-key', encodeBase64(other))
    await expect(api.tauriSecretsStore()).rejects.toMatchObject({
      name: 'PlatformError',
      code: 'io',
      message: 'Failed to move the seal key into the keychain',
    })
    expect(idb.sealKey()).toEqual(legacy)
    expect(storedPassword()).toBe(encodeBase64(other))
    expect(keyring.calls.some((call) => call.startsWith('set '))).toBe(false)
    expect(globalThis.localStorage.getItem(CIPHERTEXT_KEY)).toBe('sealed-settings-v1')
  })

  it('removes a matching IndexedDB key without writing the keychain again', async () => {
    const legacy = legacyKey()
    idb.seed('stride-secrets', 'secrets', { 'seal-key': legacy })
    keyring.entries.set('app.stride.desktop\0seal-key', encodeBase64(legacy))
    const sealed = await encryptLayout(legacy, 'sk-old')
    const store = await api.tauriSecretsStore()
    expect(idb.sealKey()).toBeUndefined()
    expect(keyring.calls.some((call) => call.startsWith('set '))).toBe(false)
    expect(await store.open(sealed)).toBe('sk-old')
  })

  it('does not mint a keychain key when the IndexedDB value is not a seal key', async () => {
    idb.seed('stride-secrets', 'secrets', { 'seal-key': new Uint8Array([1, 2, 3]) })
    await expect(api.tauriSecretsStore()).rejects.toMatchObject({ name: 'PlatformError', code: 'io' })
    expect(idb.sealKey()).toEqual(new Uint8Array([1, 2, 3]))
    expect(keyring.entries.size).toBe(0)
    expect(globalThis.localStorage.getItem(CIPHERTEXT_KEY)).toBe('sealed-settings-v1')
  })

  it('creates one keychain key when IndexedDB has no legacy database', async () => {
    await api.tauriSecretsStore()
    expect(idb.opens).toEqual([])
    expect(idb.databaseDeletes).toEqual([])
    expect(decodeBase64(storedPassword())).toHaveLength(32)
    expect(globalThis.localStorage.getItem(CIPHERTEXT_KEY)).toBe('sealed-settings-v1')
  })

  it('drops an empty database created only to probe, then stores one keychain key', async () => {
    Reflect.deleteProperty(globalThis, 'indexedDB')
    idb = new LegacyIndexedDb()
    idb.install({ databases: false })
    await api.tauriSecretsStore()
    expect(idb.opens).toEqual(['stride-secrets'])
    expect(idb.databaseDeletes).toEqual(['stride-secrets'])
    expect(idb.databases.has('stride-secrets')).toBe(false)
    expect(decodeBase64(storedPassword())).toHaveLength(32)
  })

  it('reads an existing legacy key when databases() is missing', async () => {
    Reflect.deleteProperty(globalThis, 'indexedDB')
    idb = new LegacyIndexedDb()
    const legacy = legacyKey()
    idb.seed('stride-secrets', 'secrets', { 'seal-key': legacy })
    idb.install({ databases: false })
    const store = await api.tauriSecretsStore()
    expect(idb.databaseDeletes).toEqual([])
    expect(idb.sealKey()).toBeUndefined()
    expect(decodeBase64(storedPassword())).toEqual(legacy)
    expect(await store.open(await encryptLayout(legacy, 'sk-old'))).toBe('sk-old')
  })

  async function overlapFirstOpens(): Promise<[Awaited<ReturnType<typeof api.tauriSecretsStore>>, Awaited<ReturnType<typeof api.tauriSecretsStore>>]> {
    let release: () => void = () => {}
    keyring.holdSet = new Promise((resolve) => {
      release = resolve
    })
    const pending = Promise.all([api.tauriSecretsStore(), api.tauriSecretsStore()])
    try {
      await vi.waitFor(() => {
        expect(keyring.calls.filter((call) => call.startsWith('set '))).toHaveLength(1)
      })
    } finally {
      release()
    }
    return pending
  }

  it('stores one seal key when two first opens overlap', async () => {
    const [first, second] = await overlapFirstOpens()
    expect(keyring.calls.filter((call) => call.startsWith('set '))).toHaveLength(1)
    expect(keyring.entries.size).toBe(1)
    const sealed = await first.seal('one-key')
    expect(await second.open(sealed)).toBe('one-key')
  })

  it('adopts one legacy key when two first opens overlap', async () => {
    const legacy = legacyKey()
    idb.seed('stride-secrets', 'secrets', { 'seal-key': legacy })
    let release: () => void = () => {}
    keyring.holdSet = new Promise((resolve) => {
      release = resolve
    })
    const pending = Promise.all([api.tauriSecretsStore(), api.tauriSecretsStore()])
    try {
      await vi.waitFor(() => {
        expect(keyring.calls.filter((call) => call.startsWith('set '))).toHaveLength(1)
      })
      expect(idb.sealKey()).toEqual(legacy)
    } finally {
      release()
    }
    const [first, second] = await pending
    expect(decodeBase64(storedPassword())).toEqual(legacy)
    expect(idb.sealKey()).toBeUndefined()
    expect(keyring.entries.size).toBe(1)
    const sealed = await first.seal('moved-once')
    expect(await second.open(sealed)).toBe('moved-once')
    expect(globalThis.localStorage.getItem(CIPHERTEXT_KEY)).toBe('sealed-settings-v1')
  })
})
