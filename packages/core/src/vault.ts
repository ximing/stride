import type { FileSystemBackend } from '@stride/platform'
import {
  createNote,
  isNoteFileName,
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

export async function markDedicatedVault(fs: FileSystemBackend): Promise<void> {
  await fs.writeText(
    VAULT_MARKER,
    `${JSON.stringify({ kind: 'stride-vault', version: 1 }, null, 2)}\n`,
  )
  const entry = '.stride/vane/'
  const ignore = await fs.stat('.gitignore')
  const current = ignore ? await fs.readText('.gitignore') : ''
  if (!current.split('\n').includes(entry)) {
    await fs.writeText('.gitignore', `${current.trim() ? `${current.replace(/\n$/, '')}\n` : ''}${entry}\n`)
  }
}

export async function listNoteFiles(fs: FileSystemBackend): Promise<string[]> {
  const root = await fs.stat('')
  if (!root || root.kind !== 'directory') return []
  const found: string[] = []
  const walk = async (dir: string): Promise<void> => {
    const entries = await fs.list(dir)
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === '.stride' || entry.name === 'node_modules') continue
      const full = dir ? `${dir}/${entry.name}` : entry.name
      if (entry.kind === 'directory') await walk(full)
      else if (isNoteFileName(entry.name)) found.push(full)
    }
  }
  await walk('')
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
  const files = await listNoteFiles(fs)
  const notes: StrideNote[] = []
  for (const file of files) notes.push(await readNoteFile(fs, file, noteIdFromPath(file)))
  return notes
}

export async function openVault(fs: FileSystemBackend, homeDir: string): Promise<OpenedVault> {
  const stat = await fs.stat('')
  if (!stat || stat.kind !== 'directory') {
    throw new Error('Choose an existing folder to open as a vault')
  }
  const broad = isBroadPersonalRoot(fs.rootLabel, homeDir)
  if (!broad && !(await isDedicatedVault(fs))) await markDedicatedVault(fs)
  return {
    path: fs.rootLabel,
    broad,
    dedicated: await isDedicatedVault(fs),
    notes: await loadNotes(fs),
  }
}

export async function saveNote(fs: FileSystemBackend, note: StrideNote): Promise<StrideNote> {
  const file = notePath(note.id)
  await writeNoteFile(fs, file, note)
  return readNoteFile(fs, file, note.id)
}

export async function createVaultNote(fs: FileSystemBackend, title = 'Untitled'): Promise<StrideNote> {
  const base = slugTitle(title)
  let id = base
  let n = 2
  while (await fs.stat(notePath(id))) {
    id = `${base}-${n}`
    n += 1
  }
  return saveNote(fs, createNote(id, title))
}
