import { PlatformError } from './error.ts'
import { normalizeRelativePath } from './fs.ts'

/**
 * Storage for application-private data (chat sessions, long-term memory) that
 * lives outside every vault: `~/.stride/` on desktop, IndexedDB in the browser.
 * Deliberately narrower than `FileSystemBackend` so vault semantics never leak
 * into application data.
 */
export interface AppDataStore {
  /** Reads the logical path; null when it does not exist. */
  readText(path: string): Promise<string | null>
  /** Atomic write: `<path>.tmp` first, then rename over the destination. */
  writeText(path: string, text: string): Promise<void>
  /** Appends one line (log.jsonl); creates the file when missing. */
  appendLine(path: string, line: string): Promise<void>
  /** Lists logical paths under a prefix; never lists leftover `*.tmp` files. */
  list(prefix: string): Promise<string[]>
  /** Deletes the path; a missing path is not an error. */
  remove(path: string): Promise<void>
}

// AppData paths always name a file: the store root itself is not a valid target.
export function normalizeAppDataPath(path: string): string {
  const normalized = normalizeRelativePath(path)
  if (normalized === '') throw new PlatformError('io', 'App data path must not be empty')
  return normalized
}

// Validates a list prefix like a path, but keeps the caller's form: prefixes
// match stored keys verbatim, so a trailing slash stays significant.
export function appDataListPrefix(prefix: string): string {
  normalizeRelativePath(prefix)
  return prefix.replaceAll('\\', '/')
}

export class MemoryAppDataStore implements AppDataStore {
  private readonly files = new Map<string, string>()

  async readText(path: string): Promise<string | null> {
    return this.files.get(normalizeAppDataPath(path)) ?? null
  }

  async writeText(path: string, text: string): Promise<void> {
    this.files.set(normalizeAppDataPath(path), text)
  }

  async appendLine(path: string, line: string): Promise<void> {
    const key = normalizeAppDataPath(path)
    this.files.set(key, `${this.files.get(key) ?? ''}${line}\n`)
  }

  async list(prefix: string): Promise<string[]> {
    const match = appDataListPrefix(prefix)
    const paths = [...this.files.keys()].filter((path) => path.startsWith(match) && !path.endsWith('.tmp'))
    paths.sort()
    return paths
  }

  async remove(path: string): Promise<void> {
    this.files.delete(normalizeAppDataPath(path))
  }
}
