import {
  appDataListPrefix,
  MemoryAppDataStore,
  normalizeAppDataPath,
  PlatformError,
  type AppDataStore,
} from '@stride/platform'

// Own database: @stride/fs-web opens `stride`, @stride/secrets-web opens
// `stride-secrets`. Sharing either name would risk a version race.
const DB_NAME = 'stride-appdata'
const DB_VERSION = 1
const STORE_NAME = 'files'

export interface WebAppData {
  store: AppDataStore
  /** False when IndexedDB was denied and the store only lives in memory. */
  persistent: boolean
}

function mapError(error: unknown): Error {
  if (error instanceof PlatformError) return error
  const message = error instanceof Error && error.message ? error.message : 'IndexedDB operation failed'
  return new PlatformError('io', message)
}

function openDatabase(): Promise<IDBDatabase> {
  const indexedDB = globalThis.indexedDB
  if (!indexedDB) throw new PlatformError('io', 'IndexedDB is not available')
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

/**
 * IndexedDB-backed AppDataStore: keys are logical paths, values are whole
 * strings. A single put is atomic, so writeText needs no tmp dance; the
 * interface's `<path>.tmp` contract only shows up in list filtering.
 */
class IdbAppDataStore implements AppDataStore {
  constructor(private readonly db: IDBDatabase) {}

  async readText(path: string): Promise<string | null> {
    const key = normalizeAppDataPath(path)
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(STORE_NAME, 'readonly')
      const request = tx.objectStore(STORE_NAME).get(key)
      request.onsuccess = () => resolve(typeof request.result === 'string' ? request.result : null)
      request.onerror = (event) => {
        event.preventDefault()
        reject(mapError(request.error))
      }
    })
  }

  async writeText(path: string, text: string): Promise<void> {
    const key = normalizeAppDataPath(path)
    return this.runReadwrite((store) => {
      store.put(text, key)
    })
  }

  async appendLine(path: string, line: string): Promise<void> {
    const key = normalizeAppDataPath(path)
    return new Promise((resolve, reject) => {
      let settled = false
      const fail = (error: unknown) => {
        if (settled) return
        settled = true
        reject(mapError(error))
      }
      const tx = this.db.transaction(STORE_NAME, 'readwrite')
      tx.oncomplete = () => {
        if (settled) return
        settled = true
        resolve()
      }
      tx.onerror = (event) => {
        event.preventDefault()
        fail(tx.error)
      }
      tx.onabort = () => fail(tx.error)
      const store = tx.objectStore(STORE_NAME)
      const request = store.get(key)
      request.onsuccess = () => {
        const current = typeof request.result === 'string' ? request.result : ''
        store.put(`${current}${line}\n`, key)
      }
      request.onerror = (event) => {
        event.preventDefault()
        fail(request.error)
      }
    })
  }

  async list(prefix: string): Promise<string[]> {
    const match = appDataListPrefix(prefix)
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(STORE_NAME, 'readonly')
      const range = match === '' ? null : IDBKeyRange.bound(match, `${match}￿`)
      const objectStore = tx.objectStore(STORE_NAME)
      const request = range ? objectStore.getAllKeys(range) : objectStore.getAllKeys()
      request.onsuccess = () => {
        const keys = request.result.filter(
          (key): key is string => typeof key === 'string' && !key.endsWith('.tmp'),
        )
        keys.sort()
        resolve(keys)
      }
      request.onerror = (event) => {
        event.preventDefault()
        reject(mapError(request.error))
      }
    })
  }

  async remove(path: string): Promise<void> {
    const key = normalizeAppDataPath(path)
    return this.runReadwrite((store) => {
      store.delete(key)
    })
  }

  private runReadwrite(run: (store: IDBObjectStore) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false
      const fail = (error: unknown) => {
        if (settled) return
        settled = true
        reject(mapError(error))
      }
      const tx = this.db.transaction(STORE_NAME, 'readwrite')
      tx.oncomplete = () => {
        if (settled) return
        settled = true
        resolve()
      }
      tx.onerror = (event) => {
        event.preventDefault()
        fail(tx.error)
      }
      tx.onabort = () => fail(tx.error)
      run(tx.objectStore(STORE_NAME))
    })
  }
}

// Private browsing and locked-down profiles deny IndexedDB. Unlike the secrets
// store (which must fail closed), app data degrades to memory: sessions and
// memory simply stop persisting, and the caller surfaces the loss via
// `persistent: false`.
export async function webAppDataStore(): Promise<WebAppData> {
  try {
    return { store: new IdbAppDataStore(await openDatabase()), persistent: true }
  } catch {
    return { store: new MemoryAppDataStore(), persistent: false }
  }
}
