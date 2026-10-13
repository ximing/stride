import {
  normalizeRelativePath,
  PlatformError,
  type DirEntry,
  type FileStat,
  type FileSystemBackend,
  type FileSystemCapabilities,
  type WatchEvent,
} from '@stride/platform'
import { isDomError, wrapIo } from './error.ts'
import './fs-access.ts'
import { readVaultHandle, readVaultHandleById, writeVaultHandle } from './idb.ts'

interface DirectoryPicker {
  showDirectoryPicker?: (options?: { mode?: 'read' | 'readwrite' }) => Promise<FileSystemDirectoryHandle>
}

type MovableHandle = FileSystemHandle & {
  move: (destination: FileSystemDirectoryHandle, name?: string) => Promise<void>
}

export function fileSystemAccessSupported(): boolean {
  return typeof (globalThis as DirectoryPicker).showDirectoryPicker === 'function'
}

export async function pickVaultDirectory(): Promise<BrowserFileSystem> {
  const picker = (globalThis as DirectoryPicker).showDirectoryPicker
  if (typeof picker !== 'function') {
    throw new PlatformError('unsupported', 'The File System Access API is not supported in this browser')
  }
  let handle: FileSystemDirectoryHandle
  try {
    handle = await picker.call(globalThis, { mode: 'readwrite' })
  } catch (error) {
    throw wrapIo(error, 'Failed to pick a directory')
  }
  await writeVaultHandle(handle)
  return new BrowserFileSystem(handle)
}

export async function restoreVaultDirectory(): Promise<BrowserFileSystem | null> {
  if (!fileSystemAccessSupported()) return null
  const handle = await readVaultHandle()
  if (!handle) return null
  return openGrantedDirectory(handle)
}

export async function restoreVaultById(id: string): Promise<BrowserFileSystem | null> {
  if (!fileSystemAccessSupported()) return null
  const handle = await readVaultHandleById(id)
  if (!handle) return null
  return openGrantedDirectory(handle)
}

async function openGrantedDirectory(handle: FileSystemDirectoryHandle): Promise<BrowserFileSystem | null> {
  let state: PermissionState
  try {
    state = await handle.queryPermission({ mode: 'readwrite' })
  } catch (error) {
    throw wrapIo(error, 'Failed to query directory permission')
  }
  if (state === 'granted') return new BrowserFileSystem(handle)
  if (state !== 'prompt') return null
  try {
    state = await handle.requestPermission({ mode: 'readwrite' })
  } catch (error) {
    throw wrapIo(error, 'Failed to request directory permission')
  }
  if (state === 'granted') return new BrowserFileSystem(handle)
  return null
}

export class BrowserFileSystem implements FileSystemBackend {
  readonly directoryHandle: FileSystemDirectoryHandle
  readonly rootLabel: string
  readonly capabilities: FileSystemCapabilities = { watch: false }

  constructor(private readonly root: FileSystemDirectoryHandle) {
    if (root.kind !== 'directory') throw new PlatformError('io', 'Vault root must be a directory')
    this.directoryHandle = root
    this.rootLabel = root.name
  }

  async readText(path: string): Promise<string> {
    return new TextDecoder().decode(await this.readBytes(path))
  }

  async readBytes(path: string): Promise<Uint8Array> {
    const normalized = normalizeRelativePath(path)
    const handle = await this.lookup(normalized)
    if (!handle) throw new PlatformError('not-found', `No such file: ${display(normalized)}`)
    if (handle.kind !== 'file') throw new PlatformError('io', `Not a file: ${display(normalized)}`)
    try {
      const file = await (handle as FileSystemFileHandle).getFile()
      return bytesFrom(await file.arrayBuffer())
    } catch (error) {
      if (isDomError(error, 'NotFoundError')) {
        throw new PlatformError('not-found', `No such file: ${display(normalized)}`)
      }
      throw wrapIo(error, `Failed to read ${display(normalized)}`)
    }
  }

  async writeText(path: string, data: string): Promise<void> {
    await this.writeBytes(path, new TextEncoder().encode(data))
  }

  async writeBytes(path: string, data: Uint8Array): Promise<void> {
    const normalized = normalizeRelativePath(path)
    if (normalized === '') throw new PlatformError('io', 'Cannot write a file at the root')
    const name = baseName(normalized)
    const parent = await this.ensureDirectory(parentPath(normalized))
    let handle: FileSystemFileHandle
    try {
      handle = await parent.getFileHandle(name, { create: true })
    } catch (error) {
      if (isDomError(error, 'TypeMismatchError')) {
        throw new PlatformError('io', `Cannot write a file over a directory: ${normalized}`)
      }
      throw wrapIo(error, `Failed to write ${display(normalized)}`)
    }
    await this.writeHandle(handle, data, normalized)
  }

  async list(path: string): Promise<DirEntry[]> {
    const normalized = normalizeRelativePath(path)
    const handle = await this.lookup(normalized)
    if (!handle) throw new PlatformError('not-found', `No such directory: ${display(normalized)}`)
    if (handle.kind !== 'directory') throw new PlatformError('io', `Not a directory: ${display(normalized)}`)
    const entries: DirEntry[] = []
    try {
      for await (const [name, child] of (handle as FileSystemDirectoryHandle).entries()) {
        if (child.kind === 'file' || child.kind === 'directory') entries.push({ name, kind: child.kind })
      }
    } catch (error) {
      throw wrapIo(error, `Failed to list ${display(normalized)}`)
    }
    entries.sort((a, b) => compareName(a.name, b.name))
    return entries
  }

  async mkdir(path: string): Promise<void> {
    const normalized = normalizeRelativePath(path)
    if (normalized === '') return
    const existing = await this.lookup(normalized)
    if (existing?.kind === 'file') {
      throw new PlatformError('io', `Cannot create a directory over a file: ${normalized}`)
    }
    if (existing?.kind === 'directory') return
    await this.ensureDirectory(normalized)
  }

  async rename(from: string, to: string): Promise<void> {
    const sourcePath = normalizeRelativePath(from)
    const destPath = normalizeRelativePath(to)
    if (sourcePath === '') throw new PlatformError('io', 'Cannot rename the root')
    if (destPath === '') throw new PlatformError('io', 'Cannot rename onto the root')
    if (sourcePath === destPath) return
    if (destPath.startsWith(`${sourcePath}/`)) {
      throw new PlatformError('io', 'Cannot rename a path into itself')
    }
    const source = await this.lookup(sourcePath)
    if (!source) throw new PlatformError('not-found', `No such path: ${sourcePath}`)
    await this.replaceDestination(destPath)
    const destParent = await this.ensureDirectory(parentPath(destPath))
    const destName = baseName(destPath)
    const move = movable(source)
    // move() is missing in some browsers that still ship the directory picker.
    if (move) {
      try {
        await move(destParent, destName)
      } catch (error) {
        throw wrapIo(error, `Failed to rename ${sourcePath}`)
      }
      return
    }
    await this.copyHandle(source, destParent, destName)
    await this.remove(sourcePath)
  }

  async remove(path: string): Promise<void> {
    const normalized = normalizeRelativePath(path)
    if (normalized === '') throw new PlatformError('io', 'Cannot remove the root')
    const parent = await this.lookup(parentPath(normalized))
    if (!parent || parent.kind !== 'directory') {
      throw new PlatformError('not-found', `No such path: ${normalized}`)
    }
    try {
      await (parent as FileSystemDirectoryHandle).removeEntry(baseName(normalized), { recursive: true })
    } catch (error) {
      if (isDomError(error, 'NotFoundError')) throw new PlatformError('not-found', `No such path: ${normalized}`)
      throw wrapIo(error, `Failed to remove ${normalized}`)
    }
  }

  async stat(path: string): Promise<FileStat | null> {
    const normalized = normalizeRelativePath(path)
    const handle = await this.lookup(normalized)
    if (!handle) return null
    if (handle.kind === 'directory') {
      // Directory handles do not expose mtime or size.
      return { kind: 'directory', size: 0, mtimeMs: 0 }
    }
    try {
      const file = await (handle as FileSystemFileHandle).getFile()
      const size = typeof file.size === 'number' && Number.isFinite(file.size) ? file.size : 0
      const mtimeMs = typeof file.lastModified === 'number' && Number.isFinite(file.lastModified) ? file.lastModified : 0
      return { kind: 'file', size, mtimeMs }
    } catch (error) {
      if (isDomError(error, 'NotFoundError')) return null
      throw wrapIo(error, `Failed to stat ${display(normalized)}`)
    }
  }

  async watch(path: string, _cb: (event: WatchEvent) => void): Promise<() => void> {
    normalizeRelativePath(path)
    return () => {}
  }

  private async lookup(path: string): Promise<FileSystemHandle | null> {
    if (path === '') return this.root
    const parts = path.split('/')
    let current: FileSystemDirectoryHandle = this.root
    for (const [index, name] of parts.entries()) {
      const last = index === parts.length - 1
      if (!last) {
        try {
          current = await current.getDirectoryHandle(name)
        } catch (error) {
          if (isDomError(error, 'NotFoundError') || isDomError(error, 'TypeMismatchError')) return null
          throw wrapIo(error, `Failed to resolve ${display(path)}`)
        }
        continue
      }
      try {
        return await current.getFileHandle(name)
      } catch (error) {
        if (isDomError(error, 'NotFoundError')) return null
        if (!isDomError(error, 'TypeMismatchError')) throw wrapIo(error, `Failed to resolve ${display(path)}`)
      }
      try {
        return await current.getDirectoryHandle(name)
      } catch (error) {
        if (isDomError(error, 'NotFoundError')) return null
        throw wrapIo(error, `Failed to resolve ${display(path)}`)
      }
    }
    return null
  }

  private async ensureDirectory(path: string): Promise<FileSystemDirectoryHandle> {
    if (path === '') return this.root
    let current = this.root
    let prefix = ''
    for (const segment of path.split('/')) {
      prefix = prefix ? `${prefix}/${segment}` : segment
      try {
        current = await current.getDirectoryHandle(segment, { create: true })
      } catch (error) {
        if (isDomError(error, 'TypeMismatchError')) {
          throw new PlatformError('io', `Cannot create a directory over a file: ${prefix}`)
        }
        throw wrapIo(error, `Failed to create directory ${prefix}`)
      }
    }
    return current
  }

  private async replaceDestination(destPath: string): Promise<void> {
    const existing = await this.stat(destPath)
    if (!existing) return
    if (existing.kind === 'directory') {
      const children = await this.list(destPath)
      if (children.length > 0) throw new PlatformError('already-exists', `Destination is not empty: ${destPath}`)
    }
    await this.remove(destPath)
  }

  private async writeHandle(handle: FileSystemFileHandle, data: Uint8Array, path: string): Promise<void> {
    const writable = await handle.createWritable()
    try {
      await writable.write(copyBuffer(data))
      await writable.close()
    } catch (error) {
      await writable.abort().catch(() => undefined)
      throw wrapIo(error, `Failed to write ${display(path)}`)
    }
  }

  private async copyHandle(
    source: FileSystemHandle,
    destParent: FileSystemDirectoryHandle,
    name: string,
  ): Promise<void> {
    if (source.kind === 'file') {
      try {
        const file = await (source as FileSystemFileHandle).getFile()
        const bytes = bytesFrom(await file.arrayBuffer())
        const dest = await destParent.getFileHandle(name, { create: true })
        await this.writeHandle(dest, bytes, name)
      } catch (error) {
        throw wrapIo(error, `Failed to copy ${name}`)
      }
      return
    }
    try {
      const destDir = await destParent.getDirectoryHandle(name, { create: true })
      for await (const [childName, child] of (source as FileSystemDirectoryHandle).entries()) {
        await this.copyHandle(child, destDir, childName)
      }
    } catch (error) {
      throw wrapIo(error, `Failed to copy ${name}`)
    }
  }
}

function movable(handle: FileSystemHandle): MovableHandle['move'] | null {
  const move = (handle as Partial<MovableHandle>).move
  return typeof move === 'function' ? move.bind(handle) : null
}

function copyBuffer(data: Uint8Array): ArrayBuffer {
  return bytesFrom(data).buffer
}

function bytesFrom(data: ArrayBuffer | Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(data.byteLength)
  copy.set(data instanceof Uint8Array ? data : new Uint8Array(data))
  return copy
}

function compareName(a: string, b: string): number {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

function baseName(path: string): string {
  const index = path.lastIndexOf('/')
  return index === -1 ? path : path.slice(index + 1)
}

function parentPath(path: string): string {
  const index = path.lastIndexOf('/')
  return index === -1 ? '' : path.slice(0, index)
}

function display(path: string): string {
  return path || '.'
}
