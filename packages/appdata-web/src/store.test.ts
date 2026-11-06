import { beforeEach, describe, expect, it } from 'vitest'
import { MemoryAppDataStore } from '@stride/platform'
import { registerAppDataStoreContract } from '../../platform/src/appdata-contract.ts'
import * as api from './index.ts'

interface FakeRequest {
  result: unknown
  error: DOMException | null
  onsuccess: ((event: Event) => void) | null
  onerror: ((event: Event) => void) | null
  onupgradeneeded: ((event: Event) => void) | null
}

interface RangeQuery {
  lower: string
  upper: string
}

function makeRequest(): FakeRequest {
  return { result: undefined, error: null, onsuccess: null, onerror: null, onupgradeneeded: null }
}

function isRange(query: unknown): query is RangeQuery {
  return typeof query === 'object' && query !== null && 'lower' in query && 'upper' in query
}

// Minimal IndexedDB: one database, one object store, string keys and values.
class FakeIndexedDb {
  readonly records = new Map<string, string>()
  storeCreated = false
  denyOpen = false

  private open(): FakeRequest {
    const request = makeRequest()
    queueMicrotask(() => {
      if (this.denyOpen) {
        request.error = new DOMException('The user denied permission to use IndexedDB.', 'SecurityError')
        request.onerror?.(new Event('error', { cancelable: true }))
        return
      }
      request.result = this.database()
      if (!this.storeCreated) {
        request.onupgradeneeded?.(new Event('upgradeneeded'))
        this.storeCreated = true
      }
      request.onsuccess?.(new Event('success'))
    })
    return request
  }

  private database() {
    return {
      objectStoreNames: {
        contains: (name: string) => name === 'files' && this.storeCreated,
      },
      createObjectStore: (name: string) => {
        if (name !== 'files') throw new DOMException(`Unexpected store ${name}`, 'DataError')
      },
      transaction: (name: string) => {
        if (name !== 'files') throw new DOMException(`No object store named ${name}`, 'NotFoundError')
        return this.transaction()
      },
      close: () => {},
    }
  }

  private transaction() {
    let completed = false
    const finish = () => {
      if (completed) return
      completed = true
      queueMicrotask(() => {
        tx.oncomplete?.(new Event('complete'))
      })
    }
    const records = this.records
    const tx = {
      error: null as DOMException | null,
      oncomplete: null as ((event: Event) => void) | null,
      onerror: null as ((event: Event) => void) | null,
      onabort: null as ((event: Event) => void) | null,
      objectStore: () => ({
        get: (key: string) => {
          const request = makeRequest()
          queueMicrotask(() => {
            request.result = records.get(key)
            request.onsuccess?.(new Event('success'))
            finish()
          })
          return request
        },
        put: (value: string, key: string) => {
          const request = makeRequest()
          queueMicrotask(() => {
            records.set(key, value)
            request.result = key
            request.onsuccess?.(new Event('success'))
            finish()
          })
          return request
        },
        delete: (key: string) => {
          const request = makeRequest()
          queueMicrotask(() => {
            records.delete(key)
            request.onsuccess?.(new Event('success'))
            finish()
          })
          return request
        },
        getAllKeys: (query?: unknown) => {
          const request = makeRequest()
          queueMicrotask(() => {
            let keys = [...records.keys()]
            if (isRange(query)) keys = keys.filter((key) => key >= query.lower && key < query.upper)
            keys.sort()
            request.result = keys
            request.onsuccess?.(new Event('success'))
            finish()
          })
          return request
        },
      }),
    }
    return tx
  }

  install(): void {
    globalThis.indexedDB = { open: () => this.open() } as unknown as IDBFactory
  }

  static uninstall(): void {
    Reflect.deleteProperty(globalThis, 'indexedDB')
  }
}

let idb: FakeIndexedDb

beforeEach(() => {
  idb = new FakeIndexedDb()
  idb.install()
  globalThis.IDBKeyRange = {
    bound: (lower: string, upper: string) => ({ lower, upper }),
  } as unknown as typeof IDBKeyRange
})

registerAppDataStoreContract('IdbAppDataStore', async () => (await api.webAppDataStore()).store)

describe('webAppDataStore', () => {
  it('reports a persistent store backed by the stride-appdata database', async () => {
    const { store, persistent } = await api.webAppDataStore()
    expect(persistent).toBe(true)
    await store.writeText('chats/v1/s.json', '{}')
    expect(idb.records.get('chats/v1/s.json')).toBe('{}')
  })

  it('shares records across factory calls', async () => {
    const first = await api.webAppDataStore()
    await first.store.writeText('memory/_global/index.json', '{}')
    const second = await api.webAppDataStore()
    expect(await second.store.readText('memory/_global/index.json')).toBe('{}')
  })

  it('degrades to memory when IndexedDB is missing entirely', async () => {
    FakeIndexedDb.uninstall()
    const { store, persistent } = await api.webAppDataStore()
    expect(persistent).toBe(false)
    expect(store).toBeInstanceOf(MemoryAppDataStore)
    await store.writeText('chats/v1/s.json', '{}')
    expect(await store.readText('chats/v1/s.json')).toBe('{}')
  })

  it('degrades to memory when the browser denies the open', async () => {
    idb.denyOpen = true
    const { store, persistent } = await api.webAppDataStore()
    expect(persistent).toBe(false)
    expect(store).toBeInstanceOf(MemoryAppDataStore)
  })

  it('keeps the package surface to webAppDataStore', () => {
    expect(Object.keys(api).sort()).toEqual(['webAppDataStore'])
  })
})
