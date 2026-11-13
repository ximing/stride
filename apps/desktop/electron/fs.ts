import { lstat, mkdir, readFile, readdir, rename, rm, rmdir, stat, unlink, writeFile } from 'node:fs/promises'
import type { Stats } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { watch as watchPath, type FSWatcher } from 'chokidar'
import { decodeFileBytes, encodeFileBytes, type FileInfo } from '@stride/electron-api'
import { assertTrustedSender, type RendererTrust } from './security.ts'

export interface HostSender {
  getURL(): string
  send(channel: string, payload: unknown): void
  on(event: 'destroyed', listener: () => void): void
  isDestroyed(): boolean
}

export interface HostIpcEvent {
  sender: HostSender
}

export interface HostWindow {
  isDestroyed(): boolean
}

export interface OpenDialogResult {
  canceled: boolean
  filePaths: string[]
}

export interface HostFsDeps {
  handle(channel: string, listener: (event: HostIpcEvent, payload?: unknown) => unknown): void
  getTrust(): RendererTrust
  homedir(): string
  showOpenDialog(window: HostWindow, options: { properties: Array<'openDirectory' | 'createDirectory'> }): Promise<OpenDialogResult>
  windowFromSender(sender: HostSender): HostWindow | null
}

type WatchKind = 'create' | 'modify' | 'remove'

interface LiveWatch {
  sender: HostSender
  watcher: FSWatcher
  cancelReady?: () => void
}

const watches = new Map<number, LiveWatch>()
const destroyBound = new WeakSet<HostSender>()
let nextWatchId = 1

function absolutePath(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || !isAbsolute(value)) {
    throw new Error('Rejected path')
  }
  return value
}

function requestRecord(payload: unknown): Record<string, unknown> {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error('Rejected invalid filesystem request')
  }
  return payload as Record<string, unknown>
}

function optionalBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  if (!(key in record) || record[key] === undefined) return undefined
  if (typeof record[key] !== 'boolean') throw new Error('Rejected invalid filesystem request')
  return record[key] as boolean
}

function fileInfo(stats: Stats): FileInfo {
  const symlink = stats.isSymbolicLink()
  return {
    isFile: symlink ? false : stats.isFile(),
    isDirectory: symlink ? false : stats.isDirectory(),
    isSymlink: symlink,
    size: stats.size,
    mtime: stats.mtime ?? null,
    atime: stats.atime ?? null,
    birthtime: stats.birthtime ?? null,
    readonly: (stats.mode & 0o222) === 0,
    fileAttributes: null,
    dev: stats.dev,
    ino: stats.ino,
    mode: stats.mode,
    nlink: stats.nlink,
    uid: stats.uid,
    gid: stats.gid,
    rdev: stats.rdev,
    blksize: stats.blksize,
    blocks: stats.blocks,
  }
}

function writeFlag(record: Record<string, unknown>): string {
  if (optionalBoolean(record, 'createNew')) return 'wx'
  if (optionalBoolean(record, 'append')) return 'a'
  if (optionalBoolean(record, 'create') === false) return 'r+'
  return 'w'
}

async function closeWatch(id: number): Promise<void> {
  const live = watches.get(id)
  if (!live) return
  watches.delete(id)
  live.cancelReady?.()
  await live.watcher.close()
}

function closeSender(sender: HostSender): void {
  for (const [id, live] of watches) {
    if (live.sender === sender) void closeWatch(id)
  }
}

function bindDestroy(sender: HostSender): void {
  if (destroyBound.has(sender)) return
  destroyBound.add(sender)
  sender.on('destroyed', () => {
    closeSender(sender)
  })
}

async function removePath(path: string, recursive: boolean): Promise<void> {
  if (recursive) {
    await rm(path, { recursive: true })
    return
  }
  try {
    await unlink(path)
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
    if (code === 'EISDIR' || code === 'ERR_FS_EISDIR' || code === 'EPERM') {
      await rmdir(path)
      return
    }
    throw error
  }
}

function requireWindow(sender: HostSender, deps: HostFsDeps): HostWindow {
  const window = deps.windowFromSender(sender)
  if (!window || window.isDestroyed()) throw new Error('Rejected window request for an unknown window')
  return window
}

/** Register fs, directory dialog, and home handlers. Every handler checks the sender first. */
export function registerHostFs(deps: HostFsDeps): void {
  const handle = (channel: string, listener: (event: HostIpcEvent, payload: unknown) => unknown) => {
    deps.handle(channel, (event, payload) => {
      return Promise.resolve().then(() => {
        assertTrustedSender(event, deps.getTrust())
        return listener(event, payload)
      })
    })
  }

  handle('fs:readText', async (_event, payload) => {
    const path = absolutePath(requestRecord(payload).path)
    return readFile(path, 'utf8')
  })

  handle('fs:readBytes', async (_event, payload) => {
    const path = absolutePath(requestRecord(payload).path)
    return encodeFileBytes(new Uint8Array(await readFile(path)))
  })

  handle('fs:writeText', async (_event, payload) => {
    const record = requestRecord(payload)
    const path = absolutePath(record.path)
    if (typeof record.data !== 'string') throw new Error('Rejected invalid filesystem request')
    await writeFile(path, record.data, { encoding: 'utf8', flag: writeFlag(record) })
  })

  handle('fs:writeBytes', async (_event, payload) => {
    const record = requestRecord(payload)
    const path = absolutePath(record.path)
    await writeFile(path, decodeFileBytes(record.data), { flag: writeFlag(record) })
  })

  handle('fs:list', async (_event, payload) => {
    const path = absolutePath(requestRecord(payload).path)
    const entries = await readdir(path, { withFileTypes: true })
    return entries.map((entry) => ({
      name: entry.name,
      isFile: entry.isFile(),
      isDirectory: entry.isDirectory(),
      isSymlink: entry.isSymbolicLink(),
    }))
  })

  handle('fs:mkdir', async (_event, payload) => {
    const record = requestRecord(payload)
    const path = absolutePath(record.path)
    await mkdir(path, { recursive: optionalBoolean(record, 'recursive') === true })
  })

  handle('fs:rename', async (_event, payload) => {
    const record = requestRecord(payload)
    await rename(absolutePath(record.oldPath), absolutePath(record.newPath))
  })

  handle('fs:remove', async (_event, payload) => {
    const record = requestRecord(payload)
    await removePath(absolutePath(record.path), optionalBoolean(record, 'recursive') === true)
  })

  handle('fs:stat', async (_event, payload) => fileInfo(await stat(absolutePath(requestRecord(payload).path))))

  handle('fs:lstat', async (_event, payload) => fileInfo(await lstat(absolutePath(requestRecord(payload).path))))

  handle('fs:watch', async (event, payload) => {
    const record = requestRecord(payload)
    const path = absolutePath(record.path)
    const recursive = optionalBoolean(record, 'recursive')
    const sender = event.sender
    const watcher = watchPath(path, {
      ignoreInitial: true,
      depth: recursive === false ? 0 : undefined,
    })
    const id = nextWatchId
    nextWatchId += 1
    const emit = (kind: WatchKind, file: string) => {
      if (!watches.has(id) || sender.isDestroyed()) return
      sender.send('fs:event', { id, path: isAbsolute(file) ? file : resolve(file), kind })
    }
    watcher.on('add', (file) => emit('create', file))
    watcher.on('addDir', (file) => emit('create', file))
    watcher.on('change', (file) => emit('modify', file))
    watcher.on('unlink', (file) => emit('remove', file))
    watcher.on('unlinkDir', (file) => emit('remove', file))
    const live: LiveWatch = { sender, watcher }
    watches.set(id, live)
    bindDestroy(sender)
    const abandon = async () => {
      live.cancelReady = undefined
      watches.delete(id)
      await watcher.close().catch(() => undefined)
    }
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false
        const finish = (error?: Error) => {
          if (settled) return
          settled = true
          watcher.removeListener('ready', onReady)
          watcher.removeListener('error', onError)
          if (error) reject(error)
          else resolve()
        }
        const onError = (error: unknown) => {
          finish(error instanceof Error ? error : new Error('Watch failed'))
        }
        const onReady = () => finish()
        live.cancelReady = () => finish(new Error('Watch closed before it was ready'))
        if (!watches.has(id)) {
          finish(new Error('Watch closed before it was ready'))
          return
        }
        watcher.once('ready', onReady)
        watcher.once('error', onError)
      })
    } catch (error) {
      if (watches.has(id)) await abandon()
      throw error
    }
    live.cancelReady = undefined
    if (!watches.has(id)) {
      await watcher.close().catch(() => undefined)
      throw new Error('Watch closed before it was ready')
    }
    watcher.on('error', () => {
      void closeWatch(id)
    })
    if (!watches.has(id)) {
      await watcher.close().catch(() => undefined)
      throw new Error('Watch closed before it was ready')
    }
    return { id }
  })

  handle('fs:unwatch', async (event, payload) => {
    const id = requestRecord(payload).id
    const live = typeof id === 'number' && Number.isInteger(id) ? watches.get(id) : undefined
    if (!live || live.sender !== event.sender) throw new Error('Rejected unknown watch')
    await closeWatch(id as number)
  })

  handle('host:home', () => {
    const home = deps.homedir()
    if (typeof home !== 'string' || home.length === 0) throw new Error('Home directory is empty')
    return home
  })

  handle('dialog:pickDirectory', async (event) => {
    const window = requireWindow(event.sender, deps)
    const result = await deps.showOpenDialog(window, { properties: ['openDirectory', 'createDirectory'] })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })
}
