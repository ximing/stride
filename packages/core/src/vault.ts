import fs from 'node:fs'
import path from 'node:path'
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
import os from 'node:os'

export const VAULT_MARKER = path.join('.stride', 'vault.json')

export interface OpenedVault {
  path: string
  broad: boolean
  dedicated: boolean
  notes: StrideNote[]
}

export function markerPath(vaultPath: string): string {
  return path.join(vaultPath, VAULT_MARKER)
}

export function isDedicatedVault(vaultPath: string): boolean {
  const file = markerPath(vaultPath)
  if (!fs.existsSync(file)) return false
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { kind?: string }
    return parsed.kind === 'stride-vault'
  } catch {
    return false
  }
}

export function markDedicatedVault(vaultPath: string): void {
  const file = markerPath(vaultPath)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(
    file,
    `${JSON.stringify({ kind: 'stride-vault', version: 1 }, null, 2)}\n`,
  )
  const ignore = path.join(vaultPath, '.gitignore')
  const entry = '.stride/vane/'
  const current = fs.existsSync(ignore) ? fs.readFileSync(ignore, 'utf8') : ''
  if (!current.split('\n').includes(entry)) {
    fs.writeFileSync(ignore, `${current.trim() ? `${current.replace(/\n$/, '')}\n` : ''}${entry}\n`)
  }
}

export function listNoteFiles(vaultPath: string): string[] {
  if (!fs.existsSync(vaultPath)) return []
  const found: string[] = []
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === '.stride' || entry.name === 'node_modules') continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile() && isNoteFileName(entry.name)) found.push(full)
    }
  }
  walk(vaultPath)
  return found.sort()
}

export function noteIdFromPath(vaultPath: string, filePath: string): string {
  const rel = path.relative(vaultPath, filePath)
  return rel.slice(0, -'.stride.json'.length).split(path.sep).join('/')
}

export function readNoteFile(filePath: string, id?: string): StrideNote {
  const raw = fs.readFileSync(filePath, 'utf8')
  return parseNote(raw, id ?? path.basename(filePath, '.stride.json'))
}

export function writeNoteFile(filePath: string, note: StrideNote): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, serializeNote(note))
}

export function notePath(vaultPath: string, id: string): string {
  const trimmed = id.trim()
  if (!trimmed || /[\0\\]/.test(trimmed) || path.isAbsolute(trimmed)) {
    throw new Error('Invalid note id')
  }
  if (trimmed.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    throw new Error('Invalid note id')
  }
  const root = path.resolve(vaultPath)
  const full = path.resolve(root, noteFileName(trimmed))
  const relative = path.relative(root, full)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Note path escapes the vault')
  }
  return full
}

export function loadNotes(vaultPath: string): StrideNote[] {
  return listNoteFiles(vaultPath).map((file) => readNoteFile(file, noteIdFromPath(vaultPath, file)))
}

export function openVault(vaultPath: string, homeDir = os.homedir()): OpenedVault {
  const resolved = path.resolve(vaultPath)
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error('Choose an existing folder to open as a vault')
  }
  const broad = isBroadPersonalRoot(resolved, homeDir)
  if (!broad && !isDedicatedVault(resolved)) markDedicatedVault(resolved)
  return {
    path: resolved,
    broad,
    dedicated: isDedicatedVault(resolved),
    notes: loadNotes(resolved),
  }
}

export function saveNote(vaultPath: string, note: StrideNote): StrideNote {
  writeNoteFile(notePath(vaultPath, note.id), note)
  return readNoteFile(notePath(vaultPath, note.id), note.id)
}

export function createVaultNote(vaultPath: string, title = 'Untitled'): StrideNote {
  const base = slugTitle(title)
  let id = base
  let n = 2
  while (fs.existsSync(notePath(vaultPath, id))) {
    id = `${base}-${n}`
    n += 1
  }
  const note = createNote(id, title)
  return saveNote(vaultPath, note)
}
