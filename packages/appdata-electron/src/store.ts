import {
  mkdir,
  readDir,
  readTextFile,
  remove,
  rename,
  stat,
  writeTextFile,
} from '@stride/electron-api'
import { electronHostPaths } from '@stride/fs-electron'
import {
  appDataListPrefix,
  normalizeAppDataPath,
  PlatformError,
  type AppDataStore,
} from '@stride/platform'

function errorText(error: unknown): string {
  if (typeof error === 'string') return error
  if (error instanceof Error) return error.message
  return String(error)
}

function nodeCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

// Host failures are Node errno codes (ENOENT) or legacy plugin Display strings.
// ENOENT is os error 2; Windows ERROR_PATH_NOT_FOUND is os error 3.
// Match the io detail, not the path.
function isNotFound(error: unknown): boolean {
  if (nodeCode(error) === 'ENOENT') return true
  const detail = errorText(error)
  return /\bENOENT\b/.test(detail)
    || /\bos error 2\b/.test(detail)
    || /\bos error 3\b/.test(detail)
    || /no such file or directory/i.test(detail)
    || /cannot find the (file|path)/i.test(detail)
}

function mapError(error: unknown): Error {
  if (error instanceof PlatformError) return error
  return new PlatformError('io', errorText(error))
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

/**
 * `~/.stride/` backed AppDataStore. Pure JS on top of the Electron FS bridge.
 * Writes publish by tmp-file rename so a crash can strand a `<path>.tmp`
 * file but never a half-written destination.
 */
export class ElectronAppDataStore implements AppDataStore {
  constructor(readonly root: string) {}

  async readText(path: string): Promise<string | null> {
    const relative = normalizeAppDataPath(path)
    try {
      return await readTextFile(joinRoot(this.root, relative))
    } catch (error) {
      if (isNotFound(error)) return null
      throw mapError(error)
    }
  }

  async writeText(path: string, text: string): Promise<void> {
    const relative = normalizeAppDataPath(path)
    await this.ensureParent(relative)
    const tmp = `${relative}.tmp`
    const tmpAbs = joinRoot(this.root, tmp)
    try {
      await writeTextFile(tmpAbs, text)
    } catch (error) {
      throw mapError(error)
    }
    try {
      await rename(tmpAbs, joinRoot(this.root, relative))
    } catch (error) {
      // Some hosts refuse to rename onto an occupied destination. Remove-and-rename
      // still never serves a partially written file, it just loses crash atomicity.
      if (!(await this.publishOverOccupied(tmp, relative))) {
        await remove(tmpAbs).catch(() => undefined)
        throw mapError(error)
      }
    }
  }

  async appendLine(path: string, line: string): Promise<void> {
    const relative = normalizeAppDataPath(path)
    const existing = await this.readText(relative)
    await this.writeText(relative, `${existing ?? ''}${line}\n`)
  }

  async list(prefix: string): Promise<string[]> {
    const match = appDataListPrefix(prefix)
    const paths: string[] = []
    await this.walk('', match, paths)
    paths.sort()
    return paths
  }

  async remove(path: string): Promise<void> {
    const relative = normalizeAppDataPath(path)
    try {
      await remove(joinRoot(this.root, relative))
    } catch (error) {
      if (isNotFound(error)) return
      throw mapError(error)
    }
  }

  private async publishOverOccupied(tmp: string, relative: string): Promise<boolean> {
    if (!(await this.isFile(relative))) return false
    try {
      await remove(joinRoot(this.root, relative))
      await rename(joinRoot(this.root, tmp), joinRoot(this.root, relative))
      return true
    } catch {
      await remove(joinRoot(this.root, tmp)).catch(() => undefined)
      return false
    }
  }

  private async isFile(relative: string): Promise<boolean> {
    try {
      const info = await stat(joinRoot(this.root, relative))
      return info.isFile
    } catch (error) {
      if (isNotFound(error)) return false
      throw mapError(error)
    }
  }

  private async walk(directory: string, match: string, out: string[]): Promise<void> {
    let entries: Awaited<ReturnType<typeof readDir>>
    try {
      entries = await readDir(joinRoot(this.root, directory))
    } catch (error) {
      if (isNotFound(error)) return
      throw mapError(error)
    }
    for (const entry of entries) {
      const path = directory ? `${directory}/${entry.name}` : entry.name
      if (entry.isSymlink) continue
      if (entry.isDirectory) {
        await this.walk(path, match, out)
        continue
      }
      if (!entry.isFile) continue
      if (path.endsWith('.tmp')) continue
      if (match !== '' && !path.startsWith(match)) continue
      out.push(path)
    }
  }

  private async ensureParent(relativeFile: string): Promise<void> {
    const slash = relativeFile.lastIndexOf('/')
    const parent = slash === -1 ? '' : relativeFile.slice(0, slash)
    try {
      await mkdir(joinRoot(this.root, parent), { recursive: true })
    } catch (error) {
      throw mapError(error)
    }
  }
}

export async function electronAppDataStore(): Promise<AppDataStore> {
  const home = await electronHostPaths().homeDirectory()
  return new ElectronAppDataStore(joinRoot(home, '.stride'))
}
