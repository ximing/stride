import { PlatformError } from '@stride/platform'
import { wrapIo } from './error.ts'

const DB_NAME = 'stride'
const DB_VERSION = 1
const STORE_NAME = 'fs-handles'
const VAULT_KEY = 'vault-directory'

// Chromium structured-clones a FileSystemDirectoryHandle into IndexedDB.
export async function readVaultHandle(): Promise<FileSystemDirectoryHandle | null> {
  if (!globalThis.indexedDB) return null
  try {
    const db = await openDatabase()
    try {
      const value = await getValue(db)
      return isDirectoryHandle(value) ? value : null
    } finally {
      db.close()
    }
  } catch (error) {
    throw wrapIo(error, 'Failed to read the stored directory handle')
  }
}

export async function writeVaultHandle(handle: FileSystemDirectoryHandle): Promise<void> {
  if (!globalThis.indexedDB) throw new PlatformError('io', 'IndexedDB is not available')
  try {
    const db = await openDatabase()
    try {
      await putValue(db, handle)
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
    const request = globalThis.indexedDB.open(DB_NAME, DB_VERSION)
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

function getValue(db: IDBDatabase): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly')
    const request = tx.objectStore(STORE_NAME).get(VAULT_KEY)
    request.onsuccess = () => resolve(request.result)
    request.onerror = (event) => {
      event.preventDefault()
      reject(request.error ?? new Error('Failed to read the stored directory handle'))
    }
  })
}

function putValue(db: IDBDatabase, handle: FileSystemDirectoryHandle): Promise<void> {
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
    const tx = db.transaction(STORE_NAME, 'readwrite')
    tx.oncomplete = () => ok()
    tx.onerror = (event) => {
      event.preventDefault()
      fail(tx.error)
    }
    tx.onabort = () => fail(tx.error)
    const request = tx.objectStore(STORE_NAME).put(handle, VAULT_KEY)
    request.onerror = (event) => {
      event.preventDefault()
      fail(request.error)
    }
  })
}
