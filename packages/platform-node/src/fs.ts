import fs from 'node:fs/promises'
import path from 'node:path'
import { PlatformError } from '../../platform/src/error.ts'
import type {
  DirEntry,
  FileStat,
  FileSystemBackend,
  FileSystemCapabilities,
  WatchEvent,
} from '../../platform/src/fs.ts'

// Inlined so a strip-types child can import this file without parsing MemoryFileSystem.
function normalizeRelativePath(input: string): string {
  if (input.includes('\0')) throw new PlatformError('escape', 'Path contains NUL')
  const slashed = input.replaceAll('\\', '/')
  if (slashed.startsWith('/') || /^[A-Za-z]:/.test(slashed)) {
    throw new PlatformError('escape', 'Path escapes the root')
  }
  const parts: string[] = []
  for (const segment of slashed.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') throw new PlatformError('escape', 'Path escapes the root')
    parts.push(segment)
  }
  return parts.join('/')
}

function errorCode(error: unknown): string {
  if (typeof error === 'object' && error && 'code' in error) return String((error as { code: unknown }).code)
  return ''
}

export class NodeFileSystem implements FileSystemBackend {
  readonly rootLabel: string
  readonly capabilities: FileSystemCapabilities = { watch: false }

  constructor(root: string) {
    if (!path.isAbsolute(root)) throw new PlatformError('escape', 'Root must be absolute')
    this.rootLabel = path.resolve(root)
  }

  async readText(filePath: string): Promise<string> {
    return new TextDecoder().decode(await this.readBytes(filePath))
  }

  async readBytes(filePath: string): Promise<Uint8Array> {
    const full = this.full(filePath)
    let info: Awaited<ReturnType<typeof fs.stat>>
    try {
      info = await fs.stat(full)
    } catch (error) {
      if (errorCode(error) === 'ENOENT') throw new PlatformError('not-found', `No such file: ${filePath || '.'}`)
      throw this.map(error, filePath)
    }
    if (info.isDirectory()) throw new PlatformError('io', `Not a file: ${filePath || '.'}`)
    return new Uint8Array(await fs.readFile(full))
  }

  async writeText(filePath: string, data: string): Promise<void> {
    await this.writeBytes(filePath, new TextEncoder().encode(data))
  }

  async writeBytes(filePath: string, data: Uint8Array): Promise<void> {
    const normalized = normalizeRelativePath(filePath)
    if (!normalized) throw new PlatformError('io', 'Cannot write a file at the root')
    const full = this.full(normalized)
    let existing: Awaited<ReturnType<typeof fs.stat>> | null = null
    try {
      existing = await fs.stat(full)
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw this.map(error, filePath)
    }
    if (existing?.isDirectory()) {
      throw new PlatformError('io', `Cannot write a file over a directory: ${normalized}`)
    }
    await fs.mkdir(path.dirname(full), { recursive: true })
    await fs.writeFile(full, Buffer.from(data.buffer, data.byteOffset, data.byteLength))
  }

  async list(filePath: string): Promise<DirEntry[]> {
    const full = this.full(filePath)
    let info: Awaited<ReturnType<typeof fs.stat>>
    try {
      info = await fs.stat(full)
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        throw new PlatformError('not-found', `No such directory: ${filePath || '.'}`)
      }
      throw this.map(error, filePath)
    }
    if (!info.isDirectory()) throw new PlatformError('io', `Not a directory: ${filePath || '.'}`)
    const dirents = await fs.readdir(full, { withFileTypes: true })
    const entries: DirEntry[] = []
    for (const entry of dirents) {
      if (entry.isDirectory()) entries.push({ name: entry.name, kind: 'directory' })
      else if (entry.isFile()) entries.push({ name: entry.name, kind: 'file' })
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    return entries
  }

  async mkdir(filePath: string): Promise<void> {
    const full = this.full(filePath)
    try {
      const existing = await fs.stat(full)
      if (existing.isDirectory()) return
      throw new PlatformError('io', `Cannot create a directory over a file: ${filePath}`)
    } catch (error) {
      if (error instanceof PlatformError) throw error
      if (errorCode(error) !== 'ENOENT') throw this.map(error, filePath)
    }
    await fs.mkdir(full, { recursive: true })
  }

  async rename(from: string, to: string): Promise<void> {
    const sourcePath = normalizeRelativePath(from)
    const destPath = normalizeRelativePath(to)
    if (!sourcePath) throw new PlatformError('io', 'Cannot rename the root')
    if (!destPath) throw new PlatformError('io', 'Cannot rename onto the root')
    if (sourcePath === destPath) return
    if (destPath.startsWith(`${sourcePath}/`)) throw new PlatformError('io', 'Cannot rename a path into itself')
    const source = this.full(sourcePath)
    const dest = this.full(destPath)
    try {
      await fs.stat(source)
    } catch (error) {
      if (errorCode(error) === 'ENOENT') throw new PlatformError('not-found', `No such path: ${sourcePath}`)
      throw this.map(error, from)
    }
    await fs.mkdir(path.dirname(dest), { recursive: true })
    try {
      await fs.rename(source, dest)
    } catch (error) {
      throw this.map(error, to)
    }
  }

  async remove(filePath: string): Promise<void> {
    const normalized = normalizeRelativePath(filePath)
    if (!normalized) throw new PlatformError('io', 'Cannot remove the root')
    try {
      await fs.rm(this.full(normalized), { recursive: true })
    } catch (error) {
      if (errorCode(error) === 'ENOENT') throw new PlatformError('not-found', `No such path: ${normalized}`)
      throw this.map(error, filePath)
    }
  }

  async stat(filePath: string): Promise<FileStat | null> {
    try {
      const info = await fs.stat(this.full(filePath))
      return {
        kind: info.isDirectory() ? 'directory' : 'file',
        size: info.isDirectory() ? 0 : info.size,
        mtimeMs: info.mtimeMs,
      }
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return null
      throw this.map(error, filePath)
    }
  }

  async watch(filePath: string, _cb: (event: WatchEvent) => void): Promise<() => void> {
    normalizeRelativePath(filePath)
    return () => {}
  }

  private full(input: string): string {
    const normalized = normalizeRelativePath(input)
    if (!normalized) return this.rootLabel
    const joined = path.resolve(this.rootLabel, ...normalized.split('/'))
    const relative = path.relative(this.rootLabel, joined)
    if (relative === '..' || relative.startsWith(`..${path.sep}`)) {
      throw new PlatformError('escape', 'Path escapes the root')
    }
    return joined
  }

  private map(error: unknown, rel: string): Error {
    if (error instanceof PlatformError) return error
    if (errorCode(error) === 'ENOENT') return new PlatformError('not-found', `No such path: ${rel || '.'}`)
    if (errorCode(error) === 'EEXIST') return new PlatformError('already-exists', `Already exists: ${rel}`)
    const message = error instanceof Error ? error.message : String(error)
    return new PlatformError('io', message)
  }
}
