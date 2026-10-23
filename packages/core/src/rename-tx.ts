import type { FileSystemBackend } from '@stride/platform'
import type { NoteProperty, StrideNote, TipTapNode } from './note.ts'
import { listNoteFiles, readNoteFile, writeNoteFile } from './vault.ts'

const JOURNAL_DIR = '.stride/rename-tx'
const JOURNAL_PATH = '.stride/rename-tx/journal.json'

export interface RenameChange {
  fromTitle: string
  toTitle: string
  fromId: string
  toId: string
}

export interface RenameJournalFile {
  path: string
  done: boolean
}

export interface RenameJournal {
  status: 'pending'
  fromTitle: string
  toTitle: string
  fromId: string
  toId: string
  files: RenameJournalFile[]
}

export async function rewriteVaultLinks(
  fs: FileSystemBackend,
  change: RenameChange,
  options?: { afterFile?: (index: number, journal: RenameJournal) => void | Promise<void> },
): Promise<void> {
  // An unchanged title still rewrites links that name the old id. Title links stay.
  if (change.fromTitle === change.toTitle) {
    if (change.fromId === change.toId || change.fromId === '' || change.toId === '') return
  } else if (change.fromTitle.trim() === '' || change.toTitle.trim() === '') {
    return
  }

  const paths = await listNoteFiles(fs)
  const files: RenameJournalFile[] = []
  for (const path of paths) {
    if (path.includes('.rename-tmp')) continue
    const note = await readNoteFile(fs, path)
    if (needsRewrite(note, change)) files.push({ path, done: false })
  }
  if (files.length === 0) return

  const journal: RenameJournal = {
    status: 'pending',
    fromTitle: change.fromTitle,
    toTitle: change.toTitle,
    fromId: change.fromId,
    toId: change.toId,
    files,
  }
  await fs.mkdir('.stride')
  await fs.mkdir(JOURNAL_DIR)
  await fs.writeText(JOURNAL_PATH, JSON.stringify(journal))

  for (let index = 0; index < journal.files.length; index++) {
    const file = journal.files[index]
    if (!file || file.done) continue
    await rewriteOne(fs, file.path, change)
    file.done = true
    await fs.writeText(JOURNAL_PATH, JSON.stringify(journal))
    await options?.afterFile?.(index, journal)
  }

  await removeJournal(fs)
  await removeTmpFiles(fs, journal.files)
}

export async function recoverRename(fs: FileSystemBackend): Promise<void> {
  if ((await fs.stat(JOURNAL_PATH)) == null) return

  const journal = parseJournal(await fs.readText(JOURNAL_PATH))
  const change: RenameChange = {
    fromTitle: journal.fromTitle,
    toTitle: journal.toTitle,
    fromId: journal.fromId,
    toId: journal.toId,
  }

  for (let index = 0; index < journal.files.length; index++) {
    const file = journal.files[index]
    if (!file || file.done) continue
    await rewriteOne(fs, file.path, change)
    file.done = true
    await fs.writeText(JOURNAL_PATH, JSON.stringify(journal))
  }

  await removeJournal(fs)
  await removeTmpFiles(fs, journal.files)
}

export async function rewriteOne(fs: FileSystemBackend, path: string, change: RenameChange): Promise<void> {
  const note = await readNoteFile(fs, path)
  const next = applyRewrite(note, change)
  const tmp = `${path}.rename-tmp`
  await writeNoteFile(fs, tmp, next)
  await fs.rename(tmp, path)
}

function parseJournal(text: string): RenameJournal {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error('Corrupt rename journal')
  }
  if (!isRenameJournal(value)) throw new Error('Corrupt rename journal')
  return value
}

function isRenameJournal(value: unknown): value is RenameJournal {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  if (record.status !== 'pending') return false
  if (typeof record.fromTitle !== 'string') return false
  if (typeof record.toTitle !== 'string') return false
  if (typeof record.fromId !== 'string') return false
  if (typeof record.toId !== 'string') return false
  if (!Array.isArray(record.files)) return false
  return record.files.every((file) => {
    if (typeof file !== 'object' || file === null) return false
    const item = file as Record<string, unknown>
    return typeof item.path === 'string' && typeof item.done === 'boolean'
  })
}

function needsRewrite(note: StrideNote, change: RenameChange): boolean {
  return propertiesNeedRewrite(note.properties, change) || nodeNeedsRewrite(note.doc, change)
}

function propertiesNeedRewrite(properties: StrideNote['properties'], change: RenameChange): boolean {
  if (!properties || typeof properties !== 'object') return false
  for (const value of Object.values(properties)) {
    if (value !== undefined && propertyNeedsRewrite(value, change)) return true
  }
  return false
}

function propertyNeedsRewrite(value: NoteProperty, change: RenameChange): boolean {
  if (typeof value === 'string') return textNeedsRewrite(value, change)
  if (Array.isArray(value)) {
    return value.some((item) => typeof item === 'string' && textNeedsRewrite(item, change))
  }
  return false
}

function nodeNeedsRewrite(node: TipTapNode | null | undefined, change: RenameChange): boolean {
  if (!node || typeof node !== 'object') return false
  if (node.type === 'wikilink') {
    const target = wikilinkTarget(node)
    if (target !== null && rewrittenTarget(target.trim(), change) !== null) return true
  }
  if (node.type === 'text' && typeof node.text === 'string' && textNeedsRewrite(node.text, change)) {
    return true
  }
  const content = node.content
  if (!Array.isArray(content)) return false
  return content.some((child) => nodeNeedsRewrite(child, change))
}

function applyRewrite(note: StrideNote, change: RenameChange): StrideNote {
  const copy = JSON.parse(JSON.stringify(note)) as StrideNote
  rewriteProperties(copy, change)
  if (copy.doc) rewriteNode(copy.doc, change)
  return copy
}

function rewriteProperties(note: StrideNote, change: RenameChange): void {
  const properties = note.properties
  if (!properties || typeof properties !== 'object') return
  for (const key of Object.keys(properties)) {
    const value = properties[key]
    if (value === undefined) continue
    properties[key] = rewriteProperty(value, change)
  }
}

function rewriteProperty(value: NoteProperty, change: RenameChange): NoteProperty {
  if (typeof value === 'string') return rewriteWikilinks(value, change)
  if (Array.isArray(value)) {
    return value.map((item) => (typeof item === 'string' ? rewriteWikilinks(item, change) : item)) as NoteProperty
  }
  return value
}

function rewriteNode(node: TipTapNode, change: RenameChange): void {
  if (node.type === 'wikilink') {
    const target = wikilinkTarget(node)
    const next = target === null ? null : rewrittenTarget(target.trim(), change)
    if (next !== null) setWikilinkTarget(node, next)
  }
  if (node.type === 'text' && typeof node.text === 'string') {
    node.text = rewriteWikilinks(node.text, change)
  }
  if (!Array.isArray(node.content)) return
  for (const child of node.content) {
    if (child && typeof child === 'object') rewriteNode(child, change)
  }
}

function wikilinkTarget(node: TipTapNode): string | null {
  const attrs = node.attrs as { target?: unknown } | undefined
  if (!attrs || typeof attrs.target !== 'string') return null
  return attrs.target
}

function setWikilinkTarget(node: TipTapNode, target: string): void {
  const attrs = node.attrs as { target?: string } | undefined
  if (!attrs) return
  attrs.target = target
}

function rewriteWikilinks(text: string, change: RenameChange): string {
  return text.replace(/\[\[[^\]]+\]\]/g, (token) => {
    const next = rewrittenTarget(token.slice(2, -2).trim(), change)
    if (next === null) return token
    return `[[${next}]]`
  })
}

// Title changes still land on the new title, including old-id links.
// An id-only change lands on the new id and leaves title links alone.
function rewrittenTarget(inner: string, change: RenameChange): string | null {
  if (change.fromTitle !== change.toTitle) {
    if (!isRenameTarget(inner, change)) return null
    return change.toTitle
  }
  if (inner === change.fromTitle) return null
  if (change.fromId !== '' && change.fromId !== change.toId && inner === change.fromId) return change.toId
  return null
}

function textNeedsRewrite(text: string, change: RenameChange): boolean {
  return rewriteWikilinks(text, change) !== text
}

function isRenameTarget(inner: string, change: RenameChange): boolean {
  if (change.fromTitle !== '' && inner === change.fromTitle) return true
  if (change.fromId !== '' && inner === change.fromId) return true
  return false
}

async function removeJournal(fs: FileSystemBackend): Promise<void> {
  try {
    await fs.remove(JOURNAL_PATH)
  } catch (error) {
    if (!isNotFoundError(error)) throw error
  }
}

async function removeTmpFiles(fs: FileSystemBackend, files: RenameJournalFile[]): Promise<void> {
  for (const file of files) {
    const tmp = `${file.path}.rename-tmp`
    if ((await fs.stat(tmp)) == null) continue
    await fs.remove(tmp)
  }
}

function isNotFoundError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const record = error as { code?: unknown; name?: unknown; message?: unknown }
  if (record.code === 'ENOENT' || record.code === 'NOT_FOUND' || record.code === 'not-found') return true
  if (record.name === 'NotFoundError') return true
  if (typeof record.message !== 'string') return false
  const message = record.message.toLowerCase()
  return message.includes('enoent') || message.includes('not found') || message.includes('not-found')
}
