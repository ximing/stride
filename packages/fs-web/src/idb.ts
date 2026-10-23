import { PlatformError } from '@stride/platform'
import { wrapIo } from './error.ts'

const DB_NAME = 'stride'
const DB_VERSION = 2
const HANDLE_STORE = 'fs-handles'
const VAULT_STORE = 'vault-handles'
const VAULT_KEY = 'vault-directory'

// Chromium structured-clones a FileSystemDirectoryHandle into IndexedDB.
export async function readVaultHandle(): Promise<FileSystemDirectoryHandle | null> {
  return readHandle(HANDLE_STORE, VAULT_KEY)
}

export async function writeVaultHandle(handle: FileSystemDirectoryHandle): Promise<void> {
  await writeHandle(HANDLE_STORE, VAULT_KEY, handle)
}

export async function readVaultHandleById(id: string): Promise<FileSystemDirectoryHandle | null> {
  if (!id) return null
  return readHandle(VAULT_STORE, id)
}

// Per-id handles back the registry. The legacy key stays the last opened directory
// so restoreVaultDirectory keeps working for callers that predate the registry.
export async function writeVaultHandleById(id: string, handle: FileSystemDirectoryHandle): Promise<void> {
  if (!id) throw new PlatformError('io', 'A vault id is required')
  await writeHandle(VAULT_STORE, id, handle)
  await writeVaultHandle(handle)
}

async function readHandle(storeName: string, key: IDBValidKey): Promise<FileSystemDirectoryHandle | null> {
  if (!globalThis.indexedDB) return null
  try {
    const db = await openDatabase()
    try {
      const value = await getValue(db, storeName, key)
      return isDirectoryHandle(value) ? value : null
    } finally {
      db.close()
    }
  } catch (error) {
    throw wrapIo(error, 'Failed to read the stored directory handle')
  }
}

async function writeHandle(storeName: string, key: IDBValidKey, handle: FileSystemDirectoryHandle): Promise<void> {
  if (!globalThis.indexedDB) throw new PlatformError('io', 'IndexedDB is not available')
  try {
    const db = await openDatabase()
    try {
      await putValue(db, storeName, key, handle)
    } finally {
      db.close()
    }
  } catch (error) {
    throw wrapIo(error, 'Failed to store the directory handle')
  }
}

function isDirectoryHandle(value: unknown): value is FileSystemDirectoryHandle {
  if (!value || typeof value !== 'object') return false
  const handle = value as Partial<FileSystemDirectoryHandle>
  return handle.kind === 'directory'
    && typeof handle.getDirectoryHandle === 'function'
    && typeof handle.queryPermission === 'function'
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let settled = false
    const fail = (error: unknown) => {
      if (settled) return
      settled = true
      reject(error ?? new Error('Failed to open IndexedDB'))
    }
    const request = globalThis.indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(HANDLE_STORE)) db.createObjectStore(HANDLE_STORE)
      if (!db.objectStoreNames.contains(VAULT_STORE)) db.createObjectStore(VAULT_STORE)
    }
    request.onsuccess = () => {
      if (settled) {
        request.result.close()
        return
      }
      settled = true
      resolve(request.result)
    }
    request.onerror = (event) => {
      event.preventDefault()
      fail(request.error ?? new Error('Failed to open IndexedDB'))
    }
    // Another connection can hold the upgrade forever. Fail instead of leaving the open pending.
    request.onblocked = () => {
      fail(request.error ?? new Error('Failed to open IndexedDB'))
    }
  })
}

function getValue(db: IDBDatabase, storeName: string, key: IDBValidKey): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly')
    const request = tx.objectStore(storeName).get(key)
    request.onsuccess = () => resolve(request.result)
    request.onerror = (event) => {
      event.preventDefault()
      reject(request.error ?? new Error('Failed to read the stored directory handle'))
    }
  })
}

function putValue(db: IDBDatabase, storeName: string, key: IDBValidKey, handle: FileSystemDirectoryHandle): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    const fail = (error: unknown) => {
      if (settled) return
      settled = true
      reject(error ?? new Error('Failed to store the directory handle'))
    }
    const ok = () => {
      if (settled) return
      settled = true
      resolve()
    }
    const tx = db.transaction(storeName, 'readwrite')
    tx.oncomplete = () => ok()
    tx.onerror = (event) => {
      event.preventDefault()
      fail(tx.error)
    }
    tx.onabort = () => fail(tx.error)
    const request = tx.objectStore(storeName).put(handle, key)
    request.onerror = (event) => {
      event.preventDefault()
      fail(request.error)
    }
  })
}
