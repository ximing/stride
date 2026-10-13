import {
  mkdir,
  readDir,
  readFile,
  readTextFile,
  remove,
  rename,
  stat,
  writeFile,
  writeTextFile,
} from '@tauri-apps/plugin-fs'
import {
  normalizeRelativePath,
  PlatformError,
  type DirEntry,
  type FileStat,
  type FileSystemBackend,
  type FileSystemCapabilities,
  type WatchEvent,
} from '@stride/platform'

function isAbsoluteRoot(root: string): boolean {
  if (root.startsWith('/')) return true
  if (root.startsWith('\\\\')) return true
  return /^[A-Za-z]:/.test(root)
}

function separator(root: string): '\\' | '/' {
  if (root.includes('\\')) return '\\'
  if (/^[A-Za-z]:/.test(root) && !root.includes('/')) return '\\'
  return '/'
}

function joinRoot(root: string, relative: string): string {
  if (!relative) return root
  const sep = separator(root)
  const rel = sep === '\\' ? relative.replaceAll('/', '\\') : relative
  if (root.endsWith('/') || root.endsWith('\\')) return `${root}${rel}`
  return `${root}${sep}${rel}`
}

function errorText(error: unknown): string {
  if (typeof error === 'string') return error
  if (error instanceof Error) return error.message
  return String(error)
}

// Plugin failures are serialized Display strings. ENOENT is os error 2;
// Windows ERROR_PATH_NOT_FOUND is os error 3. Match the io detail, not the path.
function isNotFound(error: unknown): boolean {
  const text = errorText(error)
  const marker = 'with error:'
  const detail = text.includes(marker) ? text.slice(text.lastIndexOf(marker) + marker.length) : text
  return /\bos error 2\b/.test(detail)
    || /\bos error 3\b/.test(detail)
    || /no such file or directory/i.test(detail)
    || /cannot find the (file|path)/i.test(detail)
}

function mapError(error: unknown, rel: string): Error {
  if (error instanceof PlatformError) return error
  if (isNotFound(error)) return new PlatformError('not-found', `No such path: ${rel || '.'}`)
  return new PlatformError('io', errorText(error))
}

export class TauriFileSystem implements FileSystemBackend {
  readonly rootLabel: string
  readonly capabilities: FileSystemCapabilities = { watch: false }

  constructor(root: string) {
    if (!isAbsoluteRoot(root)) throw new PlatformError('escape', 'Root must be absolute')
    this.rootLabel = root
  }

  async readText(filePath: string): Promise<string> {
    const relative = normalizeRelativePath(filePath)
    await this.assertFile(relative, filePath)
    try {
      return await readTextFile(joinRoot(this.rootLabel, relative))
    } catch (error) {
      if (isNotFound(error)) throw new PlatformError('not-found', `No such file: ${filePath || '.'}`)
      throw mapError(error, filePath)
    }
  }

  async readBytes(filePath: string): Promise<Uint8Array> {
    const relative = normalizeRelativePath(filePath)
    await this.assertFile(relative, filePath)
    try {
      return new Uint8Array(await readFile(joinRoot(this.rootLabel, relative)))
    } catch (error) {
      if (isNotFound(error)) throw new PlatformError('not-found', `No such file: ${filePath || '.'}`)
      throw mapError(error, filePath)
    }
  }

  async writeText(filePath: string, data: string): Promise<void> {
    const relative = await this.prepareWrite(filePath)
    try {
      await writeTextFile(joinRoot(this.rootLabel, relative), data)
    } catch (error) {
      throw mapError(error, filePath)
    }
  }

  async writeBytes(filePath: string, data: Uint8Array): Promise<void> {
    const relative = await this.prepareWrite(filePath)
    try {
      await writeFile(joinRoot(this.rootLabel, relative), data)
    } catch (error) {
      throw mapError(error, filePath)
    }
  }

  async list(filePath: string): Promise<DirEntry[]> {
    const relative = normalizeRelativePath(filePath)
    const info = await this.stat(relative)
    if (!info) throw new PlatformError('not-found', `No such directory: ${filePath || '.'}`)
    if (info.kind !== 'directory') throw new PlatformError('io', `Not a directory: ${filePath || '.'}`)
    let entries: Awaited<ReturnType<typeof readDir>>
    try {
      entries = await readDir(joinRoot(this.rootLabel, relative))
    } catch (error) {
      throw mapError(error, filePath)
    }
    const result: DirEntry[] = []
    for (const entry of entries) {
      if (entry.isDirectory) result.push({ name: entry.name, kind: 'directory' })
      else if (entry.isFile) result.push({ name: entry.name, kind: 'file' })
    }
    result.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    return result
  }

  async mkdir(filePath: string): Promise<void> {
    const relative = normalizeRelativePath(filePath)
    const existing = await this.stat(relative)
    if (existing?.kind === 'directory') return
    if (existing) throw new PlatformError('io', `Cannot create a directory over a file: ${relative}`)
    try {
      await mkdir(joinRoot(this.rootLabel, relative), { recursive: true })
    } catch (error) {
      throw mapError(error, filePath)
    }
  }

  async rename(from: string, to: string): Promise<void> {
    const sourcePath = normalizeRelativePath(from)
    const destPath = normalizeRelativePath(to)
    if (!sourcePath) throw new PlatformError('io', 'Cannot rename the root')
    if (!destPath) throw new PlatformError('io', 'Cannot rename onto the root')
    if (sourcePath === destPath) return
    if (destPath.startsWith(`${sourcePath}/`)) throw new PlatformError('io', 'Cannot rename a path into itself')
    const source = await this.stat(sourcePath)
    if (!source) throw new PlatformError('not-found', `No such path: ${sourcePath}`)
    await this.ensureParent(destPath)
    try {
      await rename(joinRoot(this.rootLabel, sourcePath), joinRoot(this.rootLabel, destPath))
    } catch (error) {
      throw mapError(error, to)
    }
  }

  async remove(filePath: string): Promise<void> {
    const relative = normalizeRelativePath(filePath)
    if (!relative) throw new PlatformError('io', 'Cannot remove the root')
    try {
      await remove(joinRoot(this.rootLabel, relative), { recursive: true })
    } catch (error) {
      if (isNotFound(error)) throw new PlatformError('not-found', `No such path: ${relative}`)
      throw mapError(error, filePath)
    }
  }

  async stat(filePath: string): Promise<FileStat | null> {
    const relative = normalizeRelativePath(filePath)
    try {
      const info = await stat(joinRoot(this.rootLabel, relative))
      return {
        kind: info.isDirectory ? 'directory' : 'file',
        size: info.isDirectory ? 0 : info.size,
        mtimeMs: info.mtime?.getTime() ?? 0,
      }
    } catch (error) {
      if (isNotFound(error)) return null
      throw mapError(error, filePath)
    }
  }

  async watch(filePath: string, _cb: (event: WatchEvent) => void): Promise<() => void> {
    normalizeRelativePath(filePath)
    return () => {}
  }

  private async assertFile(relative: string, filePath: string): Promise<void> {
    const info = await this.stat(relative)
    if (!info) throw new PlatformError('not-found', `No such file: ${filePath || '.'}`)
    if (info.kind !== 'file') throw new PlatformError('io', `Not a file: ${filePath || '.'}`)
  }

  private async prepareWrite(filePath: string): Promise<string> {
    const relative = normalizeRelativePath(filePath)
    if (!relative) throw new PlatformError('io', 'Cannot write a file at the root')
    const existing = await this.stat(relative)
    if (existing?.kind === 'directory') {
      throw new PlatformError('io', `Cannot write a file over a directory: ${relative}`)
    }
    await this.ensureParent(relative)
    return relative
  }

  private async ensureParent(relativeFile: string): Promise<void> {
    const slash = relativeFile.lastIndexOf('/')
    const parent = slash === -1 ? '' : relativeFile.slice(0, slash)
    await this.mkdir(parent)
  }
}
