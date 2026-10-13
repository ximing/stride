import { PlatformError } from './error.ts'

// `..` is rejected rather than resolved so `a/../b` cannot climb out of the root.
export function normalizeRelativePath(input: string): string {
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

export interface FileStat {
  kind: 'file' | 'directory'
  size: number
  mtimeMs: number
}

export interface DirEntry {
  name: string
  kind: 'file' | 'directory'
}

export interface WatchEvent {
  kind: 'create' | 'modify' | 'remove'
  path: string
}

export interface FileSystemCapabilities {
  watch: boolean
}

export interface FileSystemBackend {
  readonly rootLabel: string
  readonly capabilities: FileSystemCapabilities
  readText(path: string): Promise<string>
  readBytes(path: string): Promise<Uint8Array>
  writeText(path: string, data: string): Promise<void>
  writeBytes(path: string, data: Uint8Array): Promise<void>
  list(path: string): Promise<DirEntry[]>
  mkdir(path: string): Promise<void>
  rename(from: string, to: string): Promise<void>
  remove(path: string): Promise<void>
  stat(path: string): Promise<FileStat | null>
  watch(path: string, cb: (event: WatchEvent) => void): Promise<() => void>
}

interface MemFile {
  kind: 'file'
  bytes: Uint8Array
  mtimeMs: number
}

interface MemDir {
  kind: 'directory'
  mtimeMs: number
  children: Map<string, MemNode>
}

type MemNode = MemFile | MemDir

interface Watcher {
  path: string
  cb: (event: WatchEvent) => void
}

function compareName(a: string, b: string): number {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

function copyBytes(data: Uint8Array): Uint8Array {
  const copy = new Uint8Array(data.byteLength)
  copy.set(data)
  return copy
}

function watchMatches(watchPath: string, eventPath: string): boolean {
  if (watchPath === '') return true
  if (eventPath === watchPath) return true
  return eventPath.startsWith(`${watchPath}/`)
}

function removedPaths(entry: MemNode, path: string): string[] {
  const paths: string[] = []
  const walk = (current: MemNode, currentPath: string) => {
    if (current.kind === 'directory') {
      const names = [...current.children.keys()].sort(compareName)
      for (const name of names) {
        const child = current.children.get(name)
        if (!child) continue
        walk(child, currentPath ? `${currentPath}/${name}` : name)
      }
    }
    paths.push(currentPath)
  }
  walk(entry, path)
  return paths
}

export class MemoryFileSystem implements FileSystemBackend {
  readonly capabilities: FileSystemCapabilities = { watch: true }
  private clock = 0
  private readonly root: MemDir
  private readonly watchers = new Set<Watcher>()

  constructor(readonly rootLabel = 'memory') {
    this.root = { kind: 'directory', mtimeMs: this.touch(), children: new Map() }
  }

  async readText(path: string): Promise<string> {
    return new TextDecoder().decode(await this.readBytes(path))
  }

  async readBytes(path: string): Promise<Uint8Array> {
    const normalized = normalizeRelativePath(path)
    const node = this.lookup(normalized)
    if (!node) throw new PlatformError('not-found', `No such file: ${display(normalized)}`)
    if (node.kind !== 'file') throw new PlatformError('io', `Not a file: ${display(normalized)}`)
    return copyBytes(node.bytes)
  }

  async writeText(path: string, data: string): Promise<void> {
    await this.writeBytes(path, new TextEncoder().encode(data))
  }

  async writeBytes(path: string, data: Uint8Array): Promise<void> {
    const normalized = normalizeRelativePath(path)
    if (normalized === '') throw new PlatformError('io', 'Cannot write a file at the root')
    const parts = normalized.split('/')
    const name = parts[parts.length - 1]!
    const parentPath = parts.slice(0, -1).join('/')
    const { dir: parent, created } = this.ensureDirectory(parentPath)
    const existing = parent.children.get(name)
    if (existing?.kind === 'directory') {
      throw new PlatformError('io', `Cannot write a file over a directory: ${normalized}`)
    }
    const creating = !existing
    parent.children.set(name, {
      kind: 'file',
      bytes: copyBytes(data),
      mtimeMs: this.touch(),
    })
    for (const createdPath of created) this.emit('create', createdPath)
    this.emit(creating ? 'create' : 'modify', normalized)
  }

  async list(path: string): Promise<DirEntry[]> {
    const normalized = normalizeRelativePath(path)
    const node = this.lookup(normalized)
    if (!node) throw new PlatformError('not-found', `No such directory: ${display(normalized)}`)
    if (node.kind !== 'directory') throw new PlatformError('io', `Not a directory: ${display(normalized)}`)
    const entries: DirEntry[] = []
    for (const [name, child] of node.children) entries.push({ name, kind: child.kind })
    entries.sort((a, b) => compareName(a.name, b.name))
    return entries
  }

  async mkdir(path: string): Promise<void> {
    const normalized = normalizeRelativePath(path)
    const existing = this.lookup(normalized)
    if (existing?.kind === 'file') {
      throw new PlatformError('io', `Cannot create a directory over a file: ${normalized}`)
    }
    if (existing?.kind === 'directory') return
    const { created } = this.ensureDirectory(normalized)
    for (const createdPath of created) this.emit('create', createdPath)
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
    const sourceParent = this.parentOf(sourcePath)
    const source = sourceParent?.dir.children.get(sourceParent.name)
    if (!sourceParent || !source) throw new PlatformError('not-found', `No such path: ${sourcePath}`)

    const destParts = destPath.split('/')
    const destName = destParts[destParts.length - 1]!
    const destParentPath = destParts.slice(0, -1).join('/')
    const destParentExisting = this.lookup(destParentPath)
    if (destParentExisting?.kind === 'file') {
      throw new PlatformError('io', `Not a directory: ${destParentPath}`)
    }
    const existing = destParentExisting?.kind === 'directory'
      ? destParentExisting.children.get(destName)
      : undefined
    if (existing?.kind === 'directory' && existing.children.size > 0) {
      throw new PlatformError('already-exists', `Destination is not empty: ${destPath}`)
    }

    const { dir: destParent, created } = this.ensureDirectory(destParentPath)
    destParent.children.delete(destName)
    sourceParent.dir.children.delete(sourceParent.name)
    destParent.children.set(destName, source)
    for (const createdPath of created) this.emit('create', createdPath)
    this.emit('remove', sourcePath)
    this.emit('create', destPath)
  }

  async remove(path: string): Promise<void> {
    const normalized = normalizeRelativePath(path)
    if (normalized === '') throw new PlatformError('io', 'Cannot remove the root')
    const parent = this.parentOf(normalized)
    const node = parent?.dir.children.get(parent.name)
    if (!parent || !node) throw new PlatformError('not-found', `No such path: ${normalized}`)
    const paths = removedPaths(node, normalized)
    parent.dir.children.delete(parent.name)
    for (const removed of paths) this.emit('remove', removed)
  }

  async stat(path: string): Promise<FileStat | null> {
    const node = this.lookup(normalizeRelativePath(path))
    if (!node) return null
    return {
      kind: node.kind,
      size: node.kind === 'file' ? node.bytes.byteLength : 0,
      mtimeMs: node.mtimeMs,
    }
  }

  async watch(path: string, cb: (event: WatchEvent) => void): Promise<() => void> {
    const watcher: Watcher = { path: normalizeRelativePath(path), cb }
    this.watchers.add(watcher)
    return () => {
      this.watchers.delete(watcher)
    }
  }

  private touch(): number {
    const now = Date.now()
    this.clock = now > this.clock ? now : this.clock + 1
    return this.clock
  }

  private lookup(path: string): MemNode | null {
    if (path === '') return this.root
    let current: MemNode = this.root
    for (const segment of path.split('/')) {
      if (current.kind !== 'directory') return null
      const next = current.children.get(segment)
      if (!next) return null
      current = next
    }
    return current
  }

  private parentOf(path: string): { dir: MemDir; name: string } | null {
    if (path === '') return null
    const parts = path.split('/')
    const name = parts.pop()
    if (!name) return null
    const parent = this.lookup(parts.join('/'))
    if (!parent || parent.kind !== 'directory') return null
    return { dir: parent, name }
  }

  private ensureDirectory(path: string): { dir: MemDir; created: string[] } {
    const created: string[] = []
    let current = this.root
    if (path === '') return { dir: current, created }
    let prefix = ''
    for (const segment of path.split('/')) {
      prefix = prefix ? `${prefix}/${segment}` : segment
      const existing = current.children.get(segment)
      if (!existing) {
        const dir: MemDir = { kind: 'directory', mtimeMs: this.touch(), children: new Map() }
        current.children.set(segment, dir)
        created.push(prefix)
        current = dir
        continue
      }
      if (existing.kind !== 'directory') throw new PlatformError('io', `Not a directory: ${prefix}`)
      current = existing
    }
    return { dir: current, created }
  }

  private emit(kind: WatchEvent['kind'], path: string): void {
    for (const watcher of [...this.watchers]) {
      if (!watchMatches(watcher.path, path)) continue
      watcher.cb({ kind, path })
    }
  }
}

function display(path: string): string {
  return path || '.'
}
