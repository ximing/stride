import type { FileSystemBackend } from '@stride/platform'
import {
  createNote,
  isNoteFileName,
  isPlaceholderTitle,
  noteFileName,
  parseNote,
  serializeNote,
  slugTitle,
  type StrideNote,
} from './note.ts'
import { isBroadPersonalRoot } from './roots.ts'

export const VAULT_MARKER = '.stride/vault.json'

export interface OpenedVault {
  path: string
  broad: boolean
  dedicated: boolean
  notes: StrideNote[]
}

export function markerPath(vaultPath = ''): string {
  if (!vaultPath) return VAULT_MARKER
  const root = vaultPath.replace(/[\\/]+$/, '')
  return `${root}/${VAULT_MARKER}`
}

export async function isDedicatedVault(fs: FileSystemBackend): Promise<boolean> {
  const stat = await fs.stat(VAULT_MARKER)
  if (!stat || stat.kind !== 'file') return false
  try {
    const parsed = JSON.parse(await fs.readText(VAULT_MARKER)) as { kind?: string }
    return parsed.kind === 'stride-vault'
  } catch {
    return false
  }
}

export const VAULT_GITIGNORE_ENTRIES = [
  '.stride/rename-tx/',
  '.stride/vane/',
  '.stride/vane-dim',
  '.stride/search/',
] as const

export async function ensureGitignoreEntries(fs: FileSystemBackend, entries: readonly string[]): Promise<void> {
  const ignore = await fs.stat('.gitignore')
  const current = ignore ? await fs.readText('.gitignore') : ''
  const lines = current.split('\n')
  const missing = entries.filter((entry) => !lines.includes(entry))
  if (missing.length === 0) return
  const base = current.replace(/\n$/, '')
  await fs.writeText('.gitignore', `${base ? `${base}\n` : ''}${missing.join('\n')}\n`)
}

export async function markDedicatedVault(fs: FileSystemBackend): Promise<void> {
  await fs.writeText(
    VAULT_MARKER,
    `${JSON.stringify({ kind: 'stride-vault', version: 1 }, null, 2)}\n`,
  )
  await ensureGitignoreEntries(fs, VAULT_GITIGNORE_ENTRIES)
}

/** Overlaps per-file IPC without an unbounded fan-out. Directory walks share the same cap. */
export const NOTE_READ_CONCURRENCY = 8

export async function listNoteFiles(fs: FileSystemBackend): Promise<string[]> {
  const root = await fs.stat('')
  if (!root || root.kind !== 'directory') return []
  const found: string[] = []
  const queue: string[] = ['']
  let active = 0
  let settled = false
  await new Promise<void>((resolve, reject) => {
    const finish = (error?: unknown) => {
      if (settled) return
      settled = true
      if (error) reject(error)
      else resolve()
    }
    const pump = () => {
      if (settled) return
      if (queue.length === 0 && active === 0) {
        finish()
        return
      }
      while (active < NOTE_READ_CONCURRENCY && queue.length > 0) {
        const dir = queue.shift()!
        active += 1
        fs.list(dir).then((entries) => {
          if (settled) return
          for (const entry of entries) {
            if (entry.name === '.git' || entry.name === '.stride' || entry.name === 'node_modules') continue
            const full = dir ? `${dir}/${entry.name}` : entry.name
            if (entry.kind === 'directory') queue.push(full)
            else if (isNoteFileName(entry.name)) found.push(full)
          }
          active -= 1
          pump()
        }, (error) => {
          active -= 1
          finish(error)
        })
      }
    }
    pump()
  })
  return found.sort()
}

export function noteIdFromPath(filePath: string): string {
  const normalized = filePath.replaceAll('\\', '/').replace(/^\/+/, '')
  return normalized.endsWith('.stride.json')
    ? normalized.slice(0, -'.stride.json'.length)
    : normalized
}

export async function readNoteFile(fs: FileSystemBackend, filePath: string, id?: string): Promise<StrideNote> {
  const raw = await fs.readText(filePath)
  const base = filePath.split('/').pop() ?? filePath
  const fallback = base.endsWith('.stride.json') ? base.slice(0, -'.stride.json'.length) : base
  return parseNote(raw, id ?? fallback)
}

export async function writeNoteFile(fs: FileSystemBackend, filePath: string, note: StrideNote): Promise<void> {
  await fs.writeText(filePath, serializeNote(note))
}

export function notePath(id: string): string {
  const trimmed = id.trim()
  if (!trimmed || /[\0\\]/.test(trimmed) || trimmed.startsWith('/') || /^[A-Za-z]:/.test(trimmed)) {
    throw new Error('Invalid note id')
  }
  if (trimmed.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    throw new Error('Invalid note id')
  }
  return noteFileName(trimmed)
}

export async function loadNotes(fs: FileSystemBackend): Promise<StrideNote[]> {
  const notes = await loadNotesWhile(fs, () => true)
  return notes ?? []
}

/**
 * Read notes in sorted path order, at most NOTE_READ_CONCURRENCY at once.
 * Returns null when `shouldContinue` becomes false: in-flight reads finish,
 * and no further reads start. A read error after cancel is abandoned with the open.
 */
export async function loadNotesWhile(
  fs: FileSystemBackend,
  shouldContinue: () => boolean,
): Promise<StrideNote[] | null> {
  const files = await listNoteFiles(fs)
  if (!shouldContinue()) return null
  if (files.length === 0) return []
  const notes: (StrideNote | undefined)[] = new Array(files.length)
  let cursor = 0
  let aborted = false
  let failure: unknown = null
  const workers = Math.min(NOTE_READ_CONCURRENCY, files.length)
  const worker = async () => {
    while (!failure && !aborted) {
      if (!shouldContinue()) {
        aborted = true
        return
      }
      const index = cursor
      cursor += 1
      const file = files[index]
      if (!file) return
      try {
        notes[index] = await readNoteFile(fs, file, noteIdFromPath(file))
      } catch (error) {
        if (!shouldContinue()) {
          aborted = true
          return
        }
        // A mid-merge note is not TipTap JSON. Leave the file untouched so Git can resolve it.
        if (!isUnreadableNote(error)) failure = error
      }
    }
  }
  await Promise.all(Array.from({ length: workers }, () => worker()))
  if (aborted || !shouldContinue()) return null
  if (failure) throw failure
  return notes.filter((note): note is StrideNote => note !== undefined)
}

function isUnreadableNote(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('is not TipTap JSON')
    || message.includes('is not a TipTap document')
    || message.includes('not Markdown frontmatter')
}

export async function openVaultRoot(fs: FileSystemBackend, homeDir: string): Promise<Omit<OpenedVault, 'notes'>> {
  const stat = await fs.stat('')
  if (!stat || stat.kind !== 'directory') {
    throw new Error('Choose an existing folder to open as a vault')
  }
  const broad = isBroadPersonalRoot(fs.rootLabel, homeDir)
  if (!broad && !(await isDedicatedVault(fs))) await markDedicatedVault(fs)
  const dedicated = await isDedicatedVault(fs)
  if (dedicated) await ensureGitignoreEntries(fs, VAULT_GITIGNORE_ENTRIES)
  return {
    path: fs.rootLabel,
    broad,
    dedicated,
  }
}

export async function openVault(fs: FileSystemBackend, homeDir: string): Promise<OpenedVault> {
  const opened = await openVaultRoot(fs, homeDir)
  return {
    ...opened,
    notes: await loadNotes(fs),
  }
}

export async function saveNote(fs: FileSystemBackend, note: StrideNote): Promise<StrideNote> {
  const file = notePath(note.id)
  await writeNoteFile(fs, file, note)
  return readNoteFile(fs, file, note.id)
}

function newUntitledId(): string {
  const bytes = new Uint8Array(4)
  globalThis.crypto.getRandomValues(bytes)
  let suffix = ''
  for (const byte of bytes) suffix += (byte % 36).toString(36)
  return `untitled-${suffix}`
}

export async function createVaultNote(fs: FileSystemBackend, title = 'Untitled'): Promise<StrideNote> {
  if (isPlaceholderTitle(title)) {
    let id = newUntitledId()
    while (await fs.stat(notePath(id))) id = newUntitledId()
    return saveNote(fs, createNote(id, 'Untitled'))
  }
  const id = await nextSlugId(fs, title)
  return saveNote(fs, createNote(id, title))
}

// The id is the note path. A title rename keeps the current directory and only slugs the last segment.
export async function nextSlugId(fs: FileSystemBackend, title: string, currentId = ''): Promise<string> {
  const slug = slugTitle(title)
  const slash = currentId.lastIndexOf('/')
  const directory = slash === -1 ? '' : currentId.slice(0, slash)
  const base = directory ? `${directory}/${slug}` : slug
  let id = base
  let n = 2
  while (id !== currentId && (await fs.stat(notePath(id)))) {
    id = `${base}-${n}`
    n += 1
  }
  return id
}
