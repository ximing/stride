import { electronBridge, type ElectronBridge } from './index.ts'

/** Directory entry. `isSymlink` describes the entry itself and does not follow the link. */
export interface DirEntry {
  name: string
  isFile: boolean
  isDirectory: boolean
  isSymlink: boolean
}

/** File metadata. Dates cross IPC via structured clone. */
export interface FileInfo {
  isFile: boolean
  isDirectory: boolean
  isSymlink: boolean
  size: number
  mtime: Date | null
  atime: Date | null
  birthtime: Date | null
  readonly: boolean
  fileAttributes: number | null
  dev: number | null
  ino: number | null
  mode: number | null
  nlink: number | null
  uid: number | null
  gid: number | null
  rdev: number | null
  blksize: number | null
  blocks: number | null
}

export interface WriteFileOptions {
  append?: boolean
  create?: boolean
  createNew?: boolean
}

export interface MkdirOptions {
  recursive?: boolean
}

export interface RemoveOptions {
  recursive?: boolean
}

export interface WatchEvent {
  type: 'any' | 'other' | { access: { kind: string } } | { create: { kind: string } } | { modify: { kind: string } } | { remove: { kind: string } }
  paths: string[]
  attrs: unknown
}

interface FsWatchPayload {
  id: number
  path: string
  kind: 'create' | 'modify' | 'remove'
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/

export function encodeFileBytes(bytes: Uint8Array): string {
  const chunk = 0x8000
  let binary = ''
  for (let index = 0; index < bytes.length; index += chunk) {
    const slice = bytes.subarray(index, Math.min(index + chunk, bytes.length))
    binary += String.fromCharCode(...slice)
  }
  return btoa(binary)
}

/** Restore bytes from a base64 string or a byte array. Rejects truncated or out-of-range input. */
export function decodeFileBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return new Uint8Array(value)
  if (Array.isArray(value)) {
    const out = new Uint8Array(value.length)
    for (let index = 0; index < value.length; index += 1) {
      const byte = value[index]
      if (typeof byte !== 'number' || !Number.isInteger(byte) || byte < 0 || byte > 255) {
        throw new Error('Rejected invalid file bytes')
      }
      out[index] = byte
    }
    return out
  }
  if (typeof value === 'string') {
    if (value.length % 4 !== 0 || !BASE64.test(value)) throw new Error('Rejected invalid file bytes')
    let binary: string
    try {
      binary = atob(value)
    } catch {
      throw new Error('Rejected invalid file bytes')
    }
    const out = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) out[index] = binary.charCodeAt(index) & 0xff
    return out
  }
  throw new Error('Rejected invalid file bytes')
}

function bridge(): ElectronBridge {
  return electronBridge()
}

export function readTextFile(path: string): Promise<string> {
  return bridge().invoke<string>('fs:readText', { path })
}

export async function readFile(path: string): Promise<Uint8Array> {
  return decodeFileBytes(await bridge().invoke('fs:readBytes', { path }))
}

export function writeTextFile(path: string, data: string, options?: WriteFileOptions): Promise<void> {
  return bridge().invoke('fs:writeText', { path, data, ...options })
}

export function writeFile(path: string, data: Uint8Array, options?: WriteFileOptions): Promise<void> {
  return bridge().invoke('fs:writeBytes', { path, data: encodeFileBytes(data), ...options })
}

export function readDir(path: string): Promise<DirEntry[]> {
  return bridge().invoke<DirEntry[]>('fs:list', { path })
}

export function mkdir(path: string, options?: MkdirOptions): Promise<void> {
  return bridge().invoke('fs:mkdir', { path, recursive: options?.recursive })
}

export function rename(oldPath: string, newPath: string): Promise<void> {
  return bridge().invoke('fs:rename', { oldPath, newPath })
}

export function remove(path: string, options?: RemoveOptions): Promise<void> {
  return bridge().invoke('fs:remove', { path, recursive: options?.recursive })
}

export function stat(path: string): Promise<FileInfo> {
  return bridge().invoke<FileInfo>('fs:stat', { path })
}

export function lstat(path: string): Promise<FileInfo> {
  return bridge().invoke<FileInfo>('fs:lstat', { path })
}

export function homeDir(): Promise<string> {
  return bridge().invoke<string>('host:home')
}

export function pickDirectory(): Promise<string | null> {
  return bridge().invoke<string | null>('dialog:pickDirectory')
}

function isWatchPayload(value: unknown): value is FsWatchPayload {
  if (typeof value !== 'object' || value === null) return false
  const payload = value as Record<string, unknown>
  return typeof payload.id === 'number'
    && Number.isInteger(payload.id)
    && typeof payload.path === 'string'
    && (payload.kind === 'create' || payload.kind === 'modify' || payload.kind === 'remove')
}

function pluginEvent(payload: FsWatchPayload): WatchEvent {
  if (payload.kind === 'create') return { type: { create: { kind: 'any' } }, paths: [payload.path], attrs: {} }
  if (payload.kind === 'remove') return { type: { remove: { kind: 'any' } }, paths: [payload.path], attrs: {} }
  return { type: { modify: { kind: 'any' } }, paths: [payload.path], attrs: {} }
}

/**
 * Watch one absolute path. Subscribe before `fs:watch` so events that arrive during
 * the handshake stay ordered. The returned stop function is synchronous and idempotent.
 * Only `fs:event` payloads with this watch id are delivered.
 */
export async function watch(
  path: string,
  cb: (event: WatchEvent) => void,
  options?: { recursive?: boolean },
): Promise<() => void> {
  const client = bridge()
  let id: number | null = null
  let stopped = false
  let flushing = false
  const buffered: FsWatchPayload[] = []

  const deliver = (payload: FsWatchPayload) => {
    if (stopped || payload.id !== id) return
    cb(pluginEvent(payload))
  }

  const dispose = client.on('fs:event', (payload: unknown) => {
    if (!isWatchPayload(payload)) return
    if (id === null || flushing) {
      buffered.push(payload)
      return
    }
    deliver(payload)
  })

  const stop = () => {
    if (stopped) return
    stopped = true
    dispose()
    if (id !== null) void client.invoke('fs:unwatch', { id }).catch(() => undefined)
  }

  try {
    const started = await client.invoke<{ id: number }>('fs:watch', { path, recursive: options?.recursive })
    if (typeof started?.id !== 'number' || !Number.isInteger(started.id)) {
      throw new Error('Rejected invalid watch id')
    }
    if (stopped) {
      id = started.id
      void client.invoke('fs:unwatch', { id }).catch(() => undefined)
      return stop
    }
    flushing = true
    id = started.id
    while (buffered.length > 0 && !stopped) {
      const payload = buffered.shift()
      if (payload) deliver(payload)
    }
    flushing = false
  } catch (error) {
    if (id !== null) void client.invoke('fs:unwatch', { id }).catch(() => undefined)
    if (!stopped) dispose()
    throw error
  }
  return stop
}
