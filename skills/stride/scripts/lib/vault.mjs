import { readFileSync, readdirSync, realpathSync, lstatSync, openSync, closeSync, writeFileSync, fsyncSync, renameSync, unlinkSync, fchmodSync, mkdirSync, linkSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { fail, validateDocument } from './document.mjs'

export const hash = (raw) => createHash('sha256').update(raw).digest('hex')
export const rootPath = (root) => {
  if (typeof root !== 'string' || !root) fail('ARGUMENT', '--vault is required.')
  const resolved = realpathSync(root)
  if (!lstatSync(resolved).isDirectory()) fail('ARGUMENT', 'vault must be a directory.')
  return resolved
}

export function assertId(id) {
  if (typeof id !== 'string' || !id || /[\\\x00-\x1f:]/.test(id) || id.endsWith('.stride.json') ||
      id.split('/').some((part) => !part || part.startsWith('.') || part === 'node_modules')) {
    fail('INVALID_ID', 'Use a vault-relative note ID without extension, hidden segments, .., backslashes or absolute paths.')
  }
}

export function notePath(root, id) {
  assertId(id)
  const parts = `${id}.stride.json`.split('/')
  let path = root
  for (const [index, part] of parts.entries()) {
    path = join(path, part)
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) fail('SYMLINK', 'Symlinks are not followed by this tool.')
    if (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile()) fail('INVALID_ID', 'Expected directories followed by a regular note file.')
  }
  return path
}

export function load(root, id) {
  const path = notePath(root, id)
  const raw = readFileSync(path, 'utf8')
  let file
  try { file = JSON.parse(raw) } catch { fail('INVALID_DOCUMENT', `Invalid JSON in ${id}; no file was written.`) }
  validateDocument(file)
  return { id, path, raw, revision: hash(raw), file }
}

export function scan(root) {
  const entries = []
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.isSymbolicLink()) continue
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(join(dir, entry.name), relative)
      else if (entry.isFile() && entry.name.endsWith('.stride.json')) entries.push(load(root, relative.slice(0, -12)))
    }
  }
  walk(root, '')
  return entries
}

export function verifyCatalog(root, before) {
  const after = scan(root)
  if (after.length !== before.length || after.some((entry, i) => entry.id !== before[i].id || entry.revision !== before[i].revision)) {
    fail('REVISION_CONFLICT', 'Vault notes changed during relation editing. Read again and retry against the new state.')
  }
}

export function withLock(path, action) {
  const lock = join(dirname(path), `.${basename(path)}.agent.lock`)
  let fd
  try { fd = openSync(lock, 'wx', 0o600) } catch (error) {
    if (error.code === 'EEXIST') fail('LOCKED', `Another writer or stale lock exists: ${lock}. Do not remove an active writer's lock.`)
    throw error
  }
  try {
    writeFileSync(fd, JSON.stringify({ pid: process.pid, started: new Date().toISOString() }))
    return action()
  } finally {
    closeSync(fd)
    unlinkSync(lock)
  }
}

export function save(root, original, file, verify) {
  validateDocument(file)
  const raw = JSON.stringify(file, null, 2) + '\n'
  const changed = JSON.stringify(file) !== JSON.stringify(original.file)
  if (!changed) { verify(); return { changed: false, revision: original.revision } }
  const temp = join(dirname(original.path), `.${basename(original.path)}.${randomUUID()}.tmp`)
  let fd
  try {
    fd = openSync(temp, 'wx', 0o600)
    writeFileSync(fd, raw)
    fchmodSync(fd, lstatSync(original.path).mode & 0o777)
    fsyncSync(fd)
    closeSync(fd); fd = undefined
    verify()
    renameSync(temp, original.path)
  } finally {
    if (fd !== undefined) closeSync(fd)
    try { unlinkSync(temp) } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  const actual = load(root, original.id)
  if (actual.raw !== raw) fail('POST_WRITE_CONFLICT', 'File changed after replacement; write may have happened. Read current state before retrying.')
  return { changed: true, revision: actual.revision }
}

/** Resolve a new note path. Missing parents are allowed. Existing files, symlinks, and non-directories are not. */
export function newNotePath(root, id) {
  assertId(id)
  const parts = `${id}.stride.json`.split('/')
  let path = root
  let missing = false
  for (const [index, part] of parts.entries()) {
    path = join(path, part)
    if (missing) continue
    let stat
    try { stat = lstatSync(path) } catch (error) {
      if (error.code !== 'ENOENT') throw error
      stat = null
    }
    const last = index === parts.length - 1
    if (stat?.isSymbolicLink()) fail('SYMLINK', 'Symlinks are not followed by this tool.')
    if (last) {
      if (stat) fail('EXISTS', `Note ${id} already exists. Import does not overwrite.`)
    } else if (!stat) missing = true
    else if (!stat.isDirectory()) fail('INVALID_ID', 'Expected directories followed by a new note file.')
  }
  return path
}

export function createNote(root, id, file) {
  validateDocument(file)
  const path = newNotePath(root, id)
  mkdirSync(dirname(path), { recursive: true })
  const raw = JSON.stringify(file, null, 2) + '\n'
  const temp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`)
  let fd
  try {
    fd = openSync(temp, 'wx', 0o644)
    writeFileSync(fd, raw)
    fsyncSync(fd)
    closeSync(fd); fd = undefined
    try { linkSync(temp, path) } catch (error) {
      if (error.code === 'EEXIST') fail('EXISTS', `Note ${id} already exists. Import does not overwrite.`)
      throw error
    }
  } finally {
    if (fd !== undefined) closeSync(fd)
    try { unlinkSync(temp) } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  const actual = load(root, id)
  if (actual.raw !== raw) fail('POST_WRITE_CONFLICT', 'File changed after creation. Read current state before retrying.')
  return { id, changed: true, revision: actual.revision }
}
