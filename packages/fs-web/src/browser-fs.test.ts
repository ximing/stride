import { beforeEach, describe, expect, it } from 'vitest'
import { PlatformError } from '@stride/platform'
import {
  BrowserFileSystem,
  fileSystemAccessSupported,
  pickVaultDirectory,
  readVaultHandleById,
  restoreVaultById,
  restoreVaultDirectory,
  writeVaultHandleById,
} from './index.ts'

type MemNode = MemDir | MemFile

class MemDir {
  readonly kind = 'directory' as const
  readonly children = new Map<string, MemNode>()
  readonly calls: string[] = []
  readonly removed: Array<{ name: string; recursive?: boolean }> = []
  parent: MemDir | null = null
  move?: (dir: MemDir, name?: string) => Promise<void>
  permission: PermissionState = 'granted'
  requestResult: PermissionState = 'granted'
  queryCalls = 0
  requestCalls = 0
  lastQuery: { mode?: string } | undefined
  lastRequest: { mode?: string } | undefined
  name: string

  constructor(name: string) {
    this.name = name
  }

  async queryPermission(descriptor?: { mode?: string }): Promise<PermissionState> {
    this.calls.push('queryPermission')
    this.queryCalls += 1
    this.lastQuery = descriptor
    return this.permission
  }

  async requestPermission(descriptor?: { mode?: string }): Promise<PermissionState> {
    this.calls.push('requestPermission')
    this.requestCalls += 1
    this.lastRequest = descriptor
    return this.requestResult
  }

  async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<MemDir> {
    this.calls.push('getDirectoryHandle')
    const existing = this.children.get(name)
    if (!existing) {
      if (!options?.create) throw new DOMException(`Not found: ${name}`, 'NotFoundError')
      const dir = new MemDir(name)
      dir.parent = this
      this.children.set(name, dir)
      return dir
    }
    if (existing.kind !== 'directory') throw new DOMException(`Not a directory: ${name}`, 'TypeMismatchError')
    return existing
  }

  async getFileHandle(name: string, options?: { create?: boolean }): Promise<MemFile> {
    this.calls.push('getFileHandle')
    const existing = this.children.get(name)
    if (!existing) {
      if (!options?.create) throw new DOMException(`Not found: ${name}`, 'NotFoundError')
      const file = new MemFile(name)
      file.parent = this
      this.children.set(name, file)
      return file
    }
    if (existing.kind !== 'file') throw new DOMException(`Not a file: ${name}`, 'TypeMismatchError')
    return existing
  }

  async removeEntry(name: string, options?: { recursive?: boolean }): Promise<void> {
    this.calls.push('removeEntry')
    this.removed.push({ name, recursive: options?.recursive })
    const existing = this.children.get(name)
    if (!existing) throw new DOMException(`Not found: ${name}`, 'NotFoundError')
    this.children.delete(name)
    existing.parent = null
  }

  async *entries(): AsyncGenerator<[string, MemNode]> {
    this.calls.push('entries')
    for (const entry of [...this.children.entries()]) yield entry
  }
}

class MemFile {
  readonly kind = 'file' as const
  bytes = new Uint8Array()
  mtimeMs = 0
  parent: MemDir | null = null
  name: string
  move?: (dir: MemDir, name?: string) => Promise<void>

  constructor(name: string) {
    this.name = name
  }

  async getFile(): Promise<{ size: number; lastModified: number; arrayBuffer: () => Promise<ArrayBuffer> }> {
    const bytes = this.bytes.slice()
    return {
      size: bytes.byteLength,
      lastModified: this.mtimeMs,
      arrayBuffer: async () => bytes.slice().buffer,
    }
  }

  async createWritable(): Promise<{
    write: (data: BufferSource | string) => Promise<void>
    close: () => Promise<void>
    abort: () => Promise<void>
  }> {
    const chunks: Uint8Array[] = []
    return {
      write: async (data) => {
        chunks.push(chunkBytes(data))
      },
      close: async () => {
        const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
        const out = new Uint8Array(total)
        let offset = 0
        for (const chunk of chunks) {
          out.set(chunk, offset)
          offset += chunk.byteLength
        }
        this.bytes = out
        this.mtimeMs = Date.now()
      },
      abort: async () => {
        chunks.length = 0
      },
    }
  }
}

interface IdbLog {
  opens: Array<{ name: string; version: number }>
  stores: string[]
  puts: unknown[]
  gets: unknown[]
}

let idbLog: IdbLog = { opens: [], stores: [], puts: [], gets: [] }

type IdbDatabaseRecord = { version: number; stores: Map<string, Map<IDBValidKey, unknown>> }

let databases = new Map<string, IdbDatabaseRecord>()

function seedDatabase(name: string, version: number, stores: Record<string, Record<string, unknown>>): void {
  const mapped: IdbDatabaseRecord = { version, stores: new Map() }
  for (const [storeName, values] of Object.entries(stores)) {
    mapped.stores.set(storeName, new Map(Object.entries(values)))
  }
  databases.set(name, mapped)
}

function createRoot(name = 'vault'): MemDir {
  return new MemDir(name)
}

function fsFrom(root: MemDir): BrowserFileSystem {
  return new BrowserFileSystem(root as unknown as FileSystemDirectoryHandle)
}

function setPicker(picker: ((options?: { mode?: string }) => Promise<FileSystemDirectoryHandle>) | undefined): void {
  Object.defineProperty(globalThis, 'showDirectoryPicker', {
    value: picker,
    configurable: true,
    writable: true,
  })
}

function installIdb(log: IdbLog): void {
  databases = new Map()
  const event = { preventDefault() {} } as Event

  const indexedDB = {
    open(name: string, version = 1) {
      log.opens.push({ name, version })
      const request = {
        result: undefined as unknown,
        error: null as DOMException | null,
        onsuccess: null as ((ev: Event) => void) | null,
        onerror: null as ((ev: Event) => void) | null,
        onupgradeneeded: null as ((ev: Event) => void) | null,
      }
      queueMicrotask(() => {
        try {
          let found = databases.get(name)
          const oldVersion = found?.version ?? 0
          if (!found) {
            found = { version: 0, stores: new Map() }
            databases.set(name, found)
          }
          const record = found
          const db = {
            objectStoreNames: {
              contains: (storeName: string) => record.stores.has(storeName),
            },
            createObjectStore: (storeName: string) => {
              log.stores.push(storeName)
              if (!record.stores.has(storeName)) record.stores.set(storeName, new Map())
              return {}
            },
            transaction: (storeName: string) => {
              const store = record.stores.get(storeName)
              if (!store) throw new DOMException(`Missing store: ${storeName}`, 'NotFoundError')
              const tx = {
                error: null as DOMException | null,
                oncomplete: null as ((ev: Event) => void) | null,
                onerror: null as ((ev: Event) => void) | null,
                onabort: null as ((ev: Event) => void) | null,
                objectStore: () => ({
                  get: (key: IDBValidKey) => {
                    log.gets.push(key)
                    const getRequest = {
                      result: undefined as unknown,
                      error: null as DOMException | null,
                      onsuccess: null as ((ev: Event) => void) | null,
                      onerror: null as ((ev: Event) => void) | null,
                    }
                    queueMicrotask(() => {
                      getRequest.result = store.get(key)
                      getRequest.onsuccess?.(event)
                    })
                    return getRequest
                  },
                  put: (value: unknown, key: IDBValidKey) => {
                    log.puts.push(key)
                    const putRequest = {
                      result: undefined as unknown,
                      error: null as DOMException | null,
                      onsuccess: null as ((ev: Event) => void) | null,
                      onerror: null as ((ev: Event) => void) | null,
                    }
                    queueMicrotask(() => {
                      store.set(key, value)
                      putRequest.result = key
                      putRequest.onsuccess?.(event)
                      queueMicrotask(() => tx.oncomplete?.(event))
                    })
                    return putRequest
                  },
                }),
              }
              return tx
            },
            close: () => {},
          }
          request.result = db
          if (oldVersion < version) {
            request.onupgradeneeded?.(event)
            record.version = version
          }
          request.onsuccess?.(event)
        } catch (error) {
          request.error = error instanceof DOMException ? error : new DOMException(String(error), 'UnknownError')
          request.onerror?.(event)
        }
      })
      return request
    },
  }

  Object.defineProperty(globalThis, 'indexedDB', {
    value: indexedDB,
    configurable: true,
    writable: true,
  })
}

function chunkBytes(data: BufferSource | string): Uint8Array {
  if (typeof data === 'string') return new TextEncoder().encode(data)
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice()
  return new Uint8Array(data).slice()
}

function relocate(node: MemNode, dest: MemDir, name: string): void {
  node.parent?.children.delete(node.name)
  node.name = name
  node.parent = dest
  dest.children.set(name, node)
}

beforeEach(() => {
  idbLog = { opens: [], stores: [], puts: [], gets: [] }
  installIdb(idbLog)
  Reflect.deleteProperty(globalThis, 'showDirectoryPicker')
})

describe('BrowserFileSystem', () => {
  it('round-trips text and bytes', async () => {
    const fs = fsFrom(createRoot('vault'))
    expect(fs.rootLabel).toBe('vault')

    await fs.writeText('notes\\hello.txt', '你好\nstride')
    expect(await fs.readText('notes/hello.txt')).toBe('你好\nstride')
    const textStat = await fs.stat('notes/hello.txt')
    expect(textStat).toMatchObject({
      kind: 'file',
      size: new TextEncoder().encode('你好\nstride').byteLength,
    })
    expect(textStat?.mtimeMs).toBeGreaterThan(0)

    const payload = new Uint8Array([0, 1, 2, 255])
    await fs.writeBytes('bin/data.bin', payload)
    payload[0] = 9
    const read = await fs.readBytes('bin/data.bin')
    expect([...read]).toEqual([0, 1, 2, 255])
    read[0] = 7
    expect([...(await fs.readBytes('bin/data.bin'))]).toEqual([0, 1, 2, 255])
    expect((await fs.stat('bin'))).toEqual({ kind: 'directory', size: 0, mtimeMs: 0 })
  })

  it('lists one level sorted by name and creates parents', async () => {
    const fs = fsFrom(createRoot())
    await fs.mkdir('dir/m')
    await fs.mkdir('dir/m')
    await fs.writeText('dir/b.txt', 'b')
    await fs.writeText('dir/a.txt', 'a')
    await fs.mkdir('dir/c')
    await fs.writeText('dir/c/nested.txt', 'n')
    expect(await fs.list('dir')).toEqual([
      { name: 'a.txt', kind: 'file' },
      { name: 'b.txt', kind: 'file' },
      { name: 'c', kind: 'directory' },
      { name: 'm', kind: 'directory' },
    ])
    expect(await fs.list('')).toEqual([{ name: 'dir', kind: 'directory' }])
    expect(await fs.stat('dir/c')).toEqual({ kind: 'directory', size: 0, mtimeMs: 0 })
    await expect(fs.list('missing')).rejects.toMatchObject({ code: 'not-found' })
    await expect(fs.list('dir/a.txt')).rejects.toMatchObject({ code: 'io' })
    await expect(fs.readText('dir')).rejects.toMatchObject({ code: 'io' })
  })

  it('returns null for a missing stat and not-found for a missing read', async () => {
    const fs = fsFrom(createRoot())
    expect(await fs.stat('missing')).toBeNull()
    expect(await fs.stat('')).toEqual({ kind: 'directory', size: 0, mtimeMs: 0 })
    await expect(fs.readText('missing.txt')).rejects.toBeInstanceOf(PlatformError)
    await expect(fs.readText('missing.txt')).rejects.toMatchObject({ code: 'not-found' })
    await expect(fs.readBytes('missing.txt')).rejects.toMatchObject({ code: 'not-found' })
    await fs.writeText('file.txt', 'x')
    await expect(fs.mkdir('file.txt')).rejects.toMatchObject({ code: 'io' })
    await fs.mkdir('dir')
    await expect(fs.writeText('dir', 'nope')).rejects.toMatchObject({ code: 'io' })
  })

  it('removes a tree and renames files and directories', async () => {
    const root = createRoot()
    const fs = fsFrom(root)
    await fs.writeText('old/a.txt', 'A')
    await fs.mkdir('old/empty')
    await fs.rename('old', 'new/place')
    expect(await fs.readText('new/place/a.txt')).toBe('A')
    expect(await fs.stat('new/place/empty')).toEqual({ kind: 'directory', size: 0, mtimeMs: 0 })
    expect(await fs.stat('old')).toBeNull()

    await fs.writeText('new/place/b.txt', 'B')
    await fs.rename('new/place/a.txt', 'new/place/b.txt')
    expect(await fs.readText('new/place/b.txt')).toBe('A')
    expect(await fs.stat('new/place/a.txt')).toBeNull()

    await fs.writeText('loose.txt', 'loose')
    await expect(fs.rename('loose.txt', 'new')).rejects.toMatchObject({ code: 'already-exists' })
    expect(await fs.readText('loose.txt')).toBe('loose')
    expect(await fs.readText('new/place/b.txt')).toBe('A')
    await expect(fs.rename('missing.txt', 'gone/new.txt')).rejects.toMatchObject({ code: 'not-found' })
    expect(await fs.stat('gone')).toBeNull()

    await fs.remove('new')
    expect(root.removed).toContainEqual({ name: 'new', recursive: true })
    expect(await fs.stat('new')).toBeNull()
    expect(await fs.stat('new/place/b.txt')).toBeNull()
    expect(await fs.list('')).toEqual([{ name: 'loose.txt', kind: 'file' }])
    await expect(fs.remove('new')).rejects.toMatchObject({ code: 'not-found' })
  })

  it('replaces a file without removing it first', async () => {
    const root = createRoot()
    const fs = fsFrom(root)
    await fs.writeText('a.txt', 'new')
    await fs.writeText('b.txt', 'old')
    const dest = root.children.get('b.txt') as MemFile
    const parentRemoved = root.removed.map((entry) => entry.name)
    await fs.rename('a.txt', 'b.txt')
    expect(root.children.get('b.txt')).toBe(dest)
    expect(await fs.readText('b.txt')).toBe('new')
    expect(await fs.stat('a.txt')).toBeNull()
    expect(root.removed.map((entry) => entry.name)).toEqual([...parentRemoved, 'a.txt'])
  })

  it('keeps the destination file when the replacement write fails', async () => {
    const root = createRoot()
    const fs = fsFrom(root)
    await fs.writeText('a.txt', 'new')
    await fs.writeText('b.txt', 'old')
    const dest = root.children.get('b.txt') as MemFile
    dest.createWritable = async () => {
      throw new DOMException('disk full', 'QuotaExceededError')
    }
    await expect(fs.rename('a.txt', 'b.txt')).rejects.toMatchObject({ code: 'io' })
    expect(root.children.get('b.txt')).toBe(dest)
    expect(await fs.readText('b.txt')).toBe('old')
    expect(await fs.readText('a.txt')).toBe('new')
    expect(root.removed).toEqual([])
  })

  it('keeps an occupied directory when move fails before the source is published', async () => {
    const root = createRoot()
    const fs = fsFrom(root)
    await fs.mkdir('empty')
    await fs.writeText('file.txt', 'body')
    const empty = root.children.get('empty') as MemDir
    const file = root.children.get('file.txt') as MemFile
    empty.move = async () => {
      throw new DOMException('busy', 'InvalidModificationError')
    }
    file.move = async () => {
      throw new Error('source should stay until the destination is parked')
    }
    await expect(fs.rename('file.txt', 'empty')).rejects.toMatchObject({ code: 'io' })
    expect(await fs.stat('empty')).toEqual({ kind: 'directory', size: 0, mtimeMs: 0 })
    expect(await fs.readText('file.txt')).toBe('body')
    expect(root.removed).toEqual([])
    expect(root.children.get('empty')).toBe(empty)
  })

  it('replaces an empty directory via move and a file via a directory copy', async () => {
    const root = createRoot()
    const fs = fsFrom(root)
    await fs.mkdir('empty')
    await fs.writeText('file.txt', 'body')
    const empty = root.children.get('empty') as MemDir
    const file = root.children.get('file.txt') as MemFile
    empty.move = async (parent, name) => {
      relocate(empty, parent, name ?? empty.name)
    }
    file.move = async (parent, name) => {
      relocate(file, parent, name ?? file.name)
    }
    await fs.rename('file.txt', 'empty')
    expect(await fs.readText('empty')).toBe('body')
    expect(await fs.stat('file.txt')).toBeNull()
    expect(root.children.has('empty.stride-bak')).toBe(false)

    await fs.writeText('live.txt', 'old')
    await fs.writeText('tree/a.txt', 'A')
    await fs.rename('tree', 'live.txt')
    expect(await fs.readText('live.txt/a.txt')).toBe('A')
    expect(await fs.stat('tree')).toBeNull()
    expect(await fs.readText('empty')).toBe('body')
  })

  it('keeps a file when copying a directory onto it fails', async () => {
    const root = createRoot()
    const fs = fsFrom(root)
    await fs.writeText('live.txt', 'old')
    await fs.mkdir('tree')
    const tree = root.children.get('tree') as MemDir
    tree.entries = async function* entries() {
      throw new DOMException('unreadable', 'NotReadableError')
    }
    await expect(fs.rename('tree', 'live.txt')).rejects.toMatchObject({ code: 'io' })
    expect(await fs.readText('live.txt')).toBe('old')
    expect(await fs.stat('tree')).toEqual({ kind: 'directory', size: 0, mtimeMs: 0 })
    expect(root.children.has('live.txt.stride-w')).toBe(false)
  })

  it('uses move() when the handle implements it', async () => {
    const root = createRoot()
    const fs = fsFrom(root)
    await fs.writeText('dir/a.txt', 'hi')
    const dir = root.children.get('dir') as MemDir
    const file = dir.children.get('a.txt') as MemFile
    let moveArgs: { parent: string; name?: string } | null = null
    file.move = async (parent, name) => {
      moveArgs = { parent: parent.name, name }
      relocate(file, parent, name ?? file.name)
    }
    await fs.rename('dir/a.txt', 'other/b.txt')
    expect(moveArgs).toEqual({ parent: 'other', name: 'b.txt' })
    const moved = (root.children.get('other') as MemDir).children.get('b.txt')
    expect(moved).toBe(file)
    expect(await fs.readText('other/b.txt')).toBe('hi')
    expect(await fs.stat('dir/a.txt')).toBeNull()
  })

  it('rejects escape paths without calling the handle', async () => {
    const root = createRoot()
    const fs = fsFrom(root)
    await expect(fs.readText('../x')).rejects.toMatchObject({ code: 'escape' })
    await expect(fs.readBytes('/etc/passwd')).rejects.toMatchObject({ code: 'escape' })
    await expect(fs.writeText('../x', 'a')).rejects.toMatchObject({ code: 'escape' })
    await expect(fs.writeBytes('/etc/passwd', new Uint8Array())).rejects.toMatchObject({ code: 'escape' })
    await expect(fs.list('../x')).rejects.toMatchObject({ code: 'escape' })
    await expect(fs.mkdir('/etc/passwd')).rejects.toMatchObject({ code: 'escape' })
    await expect(fs.remove('../x')).rejects.toMatchObject({ code: 'escape' })
    await expect(fs.stat('/etc/passwd')).rejects.toMatchObject({ code: 'escape' })
    await expect(fs.rename('../x', 'a')).rejects.toMatchObject({ code: 'escape' })
    await expect(fs.rename('a', '/etc/passwd')).rejects.toMatchObject({ code: 'escape' })
    await expect(fs.watch('../x', () => {})).rejects.toMatchObject({ code: 'escape' })
    await expect(fs.readText('a\0b')).rejects.toMatchObject({ code: 'escape' })
    await expect(fs.readText('C:/Windows')).rejects.toMatchObject({ code: 'escape' })
    await expect(fs.readText('foo/../bar')).rejects.toMatchObject({ code: 'escape' })
    expect(root.calls).toEqual([])
  })

  it('wraps unexpected DOM failures as io', async () => {
    const root = createRoot()
    root.getFileHandle = async () => {
      throw new DOMException('disk full', 'QuotaExceededError')
    }
    const fs = fsFrom(root)
    const error = await fs.readText('a.txt').then(() => null, (caught: unknown) => caught)
    expect(error).toBeInstanceOf(PlatformError)
    expect(error).toMatchObject({ code: 'io' })
    expect(error).not.toBeInstanceOf(DOMException)
    expect((error as { cause?: unknown }).cause).toBeInstanceOf(DOMException)
    expect((error as Error).message).toMatch(/disk full/)
  })

  it('does not watch and the unsubscribe is a no-op', async () => {
    const root = createRoot()
    const fs = fsFrom(root)
    expect(fs.capabilities).toEqual({ watch: false })
    const stop = await fs.watch('notes', () => {})
    expect(() => stop()).not.toThrow()
    expect(() => stop()).not.toThrow()
    expect(root.calls).toEqual([])
  })
})

describe('vault directory picker', () => {
  it('persists the picked handle and restores it when permission is granted', async () => {
    const root = createRoot('vault')
    let pickerOptions: { mode?: string } | undefined
    setPicker(async (options) => {
      pickerOptions = options
      return root as unknown as FileSystemDirectoryHandle
    })
    expect(fileSystemAccessSupported()).toBe(true)

    const picked = await pickVaultDirectory()
    expect(pickerOptions).toEqual({ mode: 'readwrite' })
    expect(picked.rootLabel).toBe('vault')
    await picked.writeText('note.txt', 'hello')

    const restored = await restoreVaultDirectory()
    expect(restored).toBeInstanceOf(BrowserFileSystem)
    expect(restored?.rootLabel).toBe('vault')
    expect(await restored?.readText('note.txt')).toBe('hello')
    expect(root.queryCalls).toBe(1)
    expect(root.requestCalls).toBe(0)
    expect(root.lastQuery).toEqual({ mode: 'readwrite' })
    expect(idbLog.opens).toEqual([
      { name: 'stride', version: 2 },
      { name: 'stride', version: 2 },
    ])
    expect(idbLog.stores).toEqual(['fs-handles', 'vault-handles'])
    expect(idbLog.puts).toEqual(['vault-directory'])
    expect(idbLog.gets).toEqual(['vault-directory'])
  })

  it('returns null when permission is denied, dismissed, or no handle is stored', async () => {
    setPicker(async () => {
      throw new Error('picker should not run')
    })
    expect(await restoreVaultDirectory()).toBeNull()
    expect(idbLog.puts).toEqual([])

    const root = createRoot('vault')
    setPicker(async () => root as unknown as FileSystemDirectoryHandle)
    await pickVaultDirectory()
    await (await restoreVaultDirectory())?.writeText('note.txt', 'hello')

    root.permission = 'denied'
    root.requestCalls = 0
    expect(await restoreVaultDirectory()).toBeNull()
    expect(root.requestCalls).toBe(0)

    root.permission = 'prompt'
    root.requestResult = 'denied'
    root.requestCalls = 0
    expect(await restoreVaultDirectory()).toBeNull()
    expect(root.requestCalls).toBe(1)
    expect(root.lastRequest).toEqual({ mode: 'readwrite' })

    root.permission = 'prompt'
    root.requestResult = 'granted'
    root.requestCalls = 0
    const restored = await restoreVaultDirectory()
    expect(restored?.rootLabel).toBe('vault')
    expect(await restored?.readText('note.txt')).toBe('hello')
    expect(root.requestCalls).toBe(1)
  })

  it('returns null when IndexedDB or the picker is missing', async () => {
    setPicker(async () => {
      throw new Error('picker should not run')
    })
    Reflect.deleteProperty(globalThis, 'indexedDB')
    expect(await restoreVaultDirectory()).toBeNull()

    Reflect.deleteProperty(globalThis, 'showDirectoryPicker')
    installIdb(idbLog)
    expect(await restoreVaultDirectory()).toBeNull()
  })

  it('calls showDirectoryPicker with globalThis as the receiver', async () => {
    const root = createRoot('vault')
    setPicker(async function (this: unknown) {
      if (this !== globalThis) throw new TypeError('Illegal invocation')
      return root as unknown as FileSystemDirectoryHandle
    })
    const picked = await pickVaultDirectory()
    expect(picked).toBeInstanceOf(BrowserFileSystem)
    expect(picked.rootLabel).toBe('vault')
    expect(idbLog.puts).toEqual(['vault-directory'])
  })

  it('reads a vault-directory handle stored before the version bump', async () => {
    const root = createRoot('legacy')
    seedDatabase('stride', 1, { 'fs-handles': { 'vault-directory': root } })
    setPicker(async () => {
      throw new Error('picker should not run')
    })
    const restored = await restoreVaultDirectory()
    expect(restored?.rootLabel).toBe('legacy')
    expect(idbLog.opens).toEqual([{ name: 'stride', version: 2 }])
    expect(idbLog.gets).toEqual(['vault-directory'])
    expect(idbLog.puts).toEqual([])
    const record = databases.get('stride')
    expect(record?.version).toBe(2)
    expect(record?.stores.get('fs-handles')?.get('vault-directory')).toBe(root)
    expect(record?.stores.has('vault-handles')).toBe(true)
  })

  it('stores a handle per vault id and keeps the last opened vault-directory handle', async () => {
    const older = createRoot('older')
    const newer = createRoot('newer')
    setPicker(async () => {
      throw new Error('picker should not run')
    })
    await writeVaultHandleById('vault-a', older as unknown as FileSystemDirectoryHandle)
    await writeVaultHandleById('vault-b', newer as unknown as FileSystemDirectoryHandle)
    expect(await readVaultHandleById('vault-a')).toBe(older)
    expect(await readVaultHandleById('vault-b')).toBe(newer)
    expect((await restoreVaultById('vault-a'))?.rootLabel).toBe('older')
    const restored = await restoreVaultDirectory()
    expect(restored?.rootLabel).toBe('newer')
    expect(idbLog.puts).toEqual(['vault-a', 'vault-directory', 'vault-b', 'vault-directory'])
  })

  it('throws unsupported when showDirectoryPicker is absent', async () => {
    expect(fileSystemAccessSupported()).toBe(false)
    const error = await pickVaultDirectory().then(() => null, (caught: unknown) => caught)
    expect(error).toBeInstanceOf(PlatformError)
    expect(error).toMatchObject({ code: 'unsupported' })
    expect((error as Error).message).toMatch(/File System Access API/)
  })
})
