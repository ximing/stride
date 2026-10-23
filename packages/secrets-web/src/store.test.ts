import { beforeEach, describe, expect, it } from 'vitest'
import indexSource from './index.ts?raw'
import storeSource from './store.ts?raw'
import * as api from './index.ts'

interface DbState {
  version: number
  stores: Map<string, Map<string, unknown>>
}

interface OpenCall {
  name: string
  version: number
}

interface FakeRequest {
  result: unknown
  error: DOMException | null
  onsuccess: ((event: Event) => void) | null
  onerror: ((event: Event) => void) | null
  onupgradeneeded: ((event: Event) => void) | null
}

function makeRequest(): FakeRequest {
  return {
    result: undefined,
    error: null,
    onsuccess: null,
    onerror: null,
    onupgradeneeded: null,
  }
}

function cloneValue(value: unknown): unknown {
  if (value instanceof Uint8Array) return new Uint8Array(value)
  return value
}

class FakeIndexedDb {
  readonly databases = new Map<string, DbState>()
  readonly opens: OpenCall[] = []
  putStarts = 0
  holdWrites: Promise<void> | null = null

  seed(name: string, version: number, records: Record<string, Record<string, unknown>>): void {
    const stores = new Map<string, Map<string, unknown>>()
    for (const [storeName, entries] of Object.entries(records)) {
      stores.set(storeName, new Map(Object.entries(entries)))
    }
    this.databases.set(name, { version, stores })
  }

  readSealKey(): Uint8Array | undefined {
    const value = this.databases.get('stride-secrets')?.stores.get('secrets')?.get('seal-key')
    return value instanceof Uint8Array ? value : undefined
  }

  setSealKey(raw: Uint8Array): void {
    const secrets = this.databases.get('stride-secrets')?.stores.get('secrets')
    if (!secrets) throw new Error('secrets store is missing')
    secrets.set('seal-key', new Uint8Array(raw))
  }

  private open(name: string, version = 1): FakeRequest {
    this.opens.push({ name, version })
    const request = makeRequest()
    queueMicrotask(() => {
      let state = this.databases.get(name)
      if (!state) {
        state = { version: 0, stores: new Map() }
        this.databases.set(name, state)
      }
      if (version < state.version) {
        request.error = new DOMException('The requested version is lower than the existing version.', 'VersionError')
        request.onerror?.(new Event('error', { cancelable: true }))
        return
      }
      request.result = this.database(state)
      if (version > state.version) {
        request.onupgradeneeded?.(new Event('upgradeneeded'))
        state.version = version
      }
      request.onsuccess?.(new Event('success'))
    })
    return request
  }

  private database(state: DbState) {
    return {
      objectStoreNames: {
        contains: (storeName: string) => state.stores.has(storeName),
      },
      createObjectStore: (storeName: string) => {
        if (!state.stores.has(storeName)) state.stores.set(storeName, new Map())
      },
      transaction: (storeName: string) => {
        const store = state.stores.get(storeName)
        if (!store) throw new DOMException(`No object store named ${storeName}`, 'NotFoundError')
        return this.transaction(store)
      },
      close: () => {},
    }
  }

  private transaction(store: Map<string, unknown>) {
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
            request.result = cloneValue(store.get(key))
            request.onsuccess?.(new Event('success'))
            finish()
          })
          return request
        },
        put: (value: unknown, key: string) => {
          const request = makeRequest()
          this.putStarts += 1
          const commit = () => {
            store.set(key, cloneValue(value))
            request.result = key
            request.onsuccess?.(new Event('success'))
            finish()
          }
          queueMicrotask(() => {
            const held = this.holdWrites
            if (held) {
              void held.then(commit)
              return
            }
            commit()
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

  install(): void {
    const open = (name: string, version?: number) => this.open(name, version)
    globalThis.indexedDB = { open } as unknown as IDBFactory
  }
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

describe('webSecretsStore', () => {
  let idb: FakeIndexedDb

  beforeEach(() => {
    idb = new FakeIndexedDb()
    idb.install()
  })

  it('seals and opens an empty string as empty', async () => {
    const store = await api.webSecretsStore()
    expect(await store.seal('')).toBe('')
    expect(await store.open('')).toBe('')
  })

  it('round-trips a non-empty string as base64 of iv and ciphertext-with-tag', async () => {
    const store = await api.webSecretsStore()
    const sealed = await store.seal('sk-live-secret')
    expect(sealed).toMatch(/^[A-Za-z0-9+/]+={0,2}$/)
    expect(sealed).not.toBe('sk-live-secret')
    const packed = decodeBase64(sealed)
    expect(packed.length).toBe(12 + new TextEncoder().encode('sk-live-secret').length + 16)
    expect(await store.open(sealed)).toBe('sk-live-secret')
    const raw = idb.readSealKey()
    expect(raw).toBeInstanceOf(Uint8Array)
    expect(await decryptLayout(raw!, sealed)).toBe('sk-live-secret')
  })

  it('opens a seal from a second instance that reads the same key', async () => {
    const first = await api.webSecretsStore()
    const sealed = await first.seal('shared-secret')
    const persisted = new Uint8Array(idb.readSealKey()!)
    const second = await api.webSecretsStore()
    expect(second).not.toBe(first)
    expect(idb.readSealKey()).toEqual(persisted)
    expect(await second.open(sealed)).toBe('shared-secret')
    expect(await first.open(sealed)).toBe('shared-secret')
  })

  it('stores one seal key when two first creates overlap', async () => {
    let release: () => void = () => {}
    idb.holdWrites = new Promise((resolve) => {
      release = resolve
    })
    const pending = Promise.all([api.webSecretsStore(), api.webSecretsStore()])
    try {
      for (let i = 0; i < 30 && idb.putStarts === 0; i += 1) {
        await new Promise((resolve) => queueMicrotask(resolve))
      }
      for (let i = 0; i < 10; i += 1) {
        await new Promise((resolve) => queueMicrotask(resolve))
      }
      expect(idb.putStarts).toBe(1)
      expect(idb.opens).toEqual([{ name: 'stride-secrets', version: 1 }])
      expect(idb.readSealKey()).toBeUndefined()
    } finally {
      release()
      idb.holdWrites = null
    }
    const [first, second] = await pending
    expect(first).not.toBe(second)
    expect(idb.putStarts).toBe(1)
    const raw = idb.readSealKey()
    expect(raw).toHaveLength(32)
    const sealed = await first.seal('one-key')
    expect(await second.open(sealed)).toBe('one-key')
    expect(await first.open(await second.seal('one-key'))).toBe('one-key')
    expect(await decryptLayout(raw!, sealed)).toBe('one-key')
  })

  it('fails open with io when the persisted key is different', async () => {
    const store = await api.webSecretsStore()
    const sealed = await store.seal('top-secret')
    const other = new Uint8Array(32)
    other[0] = 9
    idb.setSealKey(other)
    const mismatched = await api.webSecretsStore()
    await expect(mismatched.open(sealed)).rejects.toMatchObject({ name: 'PlatformError', code: 'io' })
    expect(await store.open(sealed)).toBe('top-secret')
  })

  it('persists a random 32-byte key in stride-secrets and leaves the fs database alone', async () => {
    idb.seed('stride', 1, { 'fs-handles': { 'vault-directory': { kind: 'directory' } } })
    await api.webSecretsStore()
    const raw = idb.readSealKey()
    expect(raw).toHaveLength(32)
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('stride-settings-v1')))
    expect(raw).not.toEqual(digest)
    expect(idb.opens.map((call) => `${call.name}@${call.version}`)).toEqual(['stride-secrets@1'])
    expect(idb.databases.get('stride')?.version).toBe(1)
    expect(idb.databases.get('stride')?.stores.has('fs-handles')).toBe(true)
    expect(idb.databases.get('stride')?.stores.has('secrets')).toBe(false)
    expect(idb.databases.get('stride')?.stores.get('fs-handles')?.get('vault-directory')).toEqual({ kind: 'directory' })
  })

  it('creates the secrets store without deleting stores already in the database', async () => {
    idb.seed('stride-secrets', 0, { other: { keep: 'yes' } })
    await api.webSecretsStore()
    const state = idb.databases.get('stride-secrets')
    expect(state?.version).toBe(1)
    expect(state?.stores.get('other')?.get('keep')).toBe('yes')
    expect(state?.stores.has('secrets')).toBe(true)
    expect(idb.readSealKey()).toHaveLength(32)
  })

  it('does not reimplement maskSecret', () => {
    const source = `${indexSource}\n${storeSource}`
    expect(source).not.toContain('maskSecret')
    expect(source).not.toContain('••••')
    expect(source).not.toContain('stride-settings-v1')
    expect(source).not.toContain('deriveKey')
    expect(Object.keys(api).sort()).toEqual(['webSecretsStore'])
    expect(api).not.toHaveProperty('maskSecret')
  })
})
