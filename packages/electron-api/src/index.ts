export const ELECTRON_BRIDGE_KEY = '__STRIDE_ELECTRON__' as const

export const ELECTRON_REQUEST_CHANNELS = Object.freeze([
  'app:info',
  'app:exit',
  'app:relaunch',
  'host:home',
  'host:fetch',
  'host:fetchAbort',
  'host:fonts',
  'host:openExternal',
  'dialog:pickDirectory',
  'fs:readText',
  'fs:readBytes',
  'fs:writeText',
  'fs:writeBytes',
  'fs:list',
  'fs:mkdir',
  'fs:rename',
  'fs:remove',
  'fs:stat',
  'fs:lstat',
  'fs:watch',
  'fs:unwatch',
  'git:exec',
  'secrets:getOrCreateKey',
  'shell:spawn',
  'shell:cancel',
  'agent:spawn',
  'agent:write',
  'agent:kill',
  'agent:which',
  'agent:probe',
  'window:intent',
  'window:setProject',
  'window:new',
  'window:newProject',
  'window:openProject',
  'window:control',
  'window:state',
  'window:syncRecent',
  'updater:check',
  'updater:download',
  'updater:install',
  'updater:relaunch',
] as const)

export const ELECTRON_EVENT_CHANNELS = Object.freeze([
  'fs:event',
  'host:fetch:event',
  'shell:event',
  'agent:event',
  'window:intent',
  'window:recent',
  'window:state',
  'deep-link:open',
  'updater:event',
] as const)

export type ElectronRequestChannel = (typeof ELECTRON_REQUEST_CHANNELS)[number]
export type ElectronEventChannel = (typeof ELECTRON_EVENT_CHANNELS)[number]

export type ChannelSet<T extends string> = Pick<ReadonlySet<T>, 'size' | 'has' | 'keys' | 'values' | 'entries'> & {
  forEach(callbackfn: (value: T, value2: T, set: ChannelSet<T>) => void, thisArg?: unknown): void
  [Symbol.iterator](): IterableIterator<T>
  readonly [Symbol.toStringTag]: string
}

export const ELECTRON_REQUEST_CHANNEL_SET: ChannelSet<ElectronRequestChannel> =
  immutableSet(ELECTRON_REQUEST_CHANNELS)
export const ELECTRON_EVENT_CHANNEL_SET: ChannelSet<ElectronEventChannel> =
  immutableSet(ELECTRON_EVENT_CHANNELS)

export function isElectronRequestChannel(value: unknown): value is ElectronRequestChannel {
  return typeof value === 'string' && ELECTRON_REQUEST_CHANNEL_SET.has(value as ElectronRequestChannel)
}

export function isElectronEventChannel(value: unknown): value is ElectronEventChannel {
  return typeof value === 'string' && ELECTRON_EVENT_CHANNEL_SET.has(value as ElectronEventChannel)
}

export interface AppInfo {
  version: string
  platform: string
}

export type WindowControlAction = 'close' | 'minimize' | 'toggleMaximize'

export interface WindowStateSnapshot {
  maximized: boolean
  minimized: boolean
  fullscreen: boolean
}

export type ElectronDisposer = () => void

export interface ElectronBridge<TResult = unknown, TEvent = unknown> {
  invoke<T = TResult>(channel: ElectronRequestChannel, args?: unknown): Promise<T>
  on<T = TEvent>(channel: ElectronEventChannel, listener: (payload: T) => void): ElectronDisposer
}

interface RawElectronBridge {
  invoke: (channel: string, args?: unknown) => unknown
  on: (channel: string, listener: (payload: unknown) => void) => unknown
}

export function electronBridge<TResult = unknown, TEvent = unknown>(): ElectronBridge<TResult, TEvent> {
  const value = (globalThis as Record<string, unknown>)[ELECTRON_BRIDGE_KEY]
  if (value === null || typeof value !== 'object') {
    throw bridgeShapeError(
      `globalThis[${JSON.stringify(ELECTRON_BRIDGE_KEY)}] is ${value === null ? 'null' : typeof value}`,
    )
  }
  const record = value as Record<string, unknown>
  if (typeof record.invoke !== 'function') {
    throw bridgeShapeError('invoke is not a function')
  }
  if (typeof record.on !== 'function') {
    throw bridgeShapeError('on is not a function')
  }
  return createBridge(record as unknown as RawElectronBridge)
}

function createBridge(raw: RawElectronBridge): ElectronBridge {
  return {
    invoke(channel, args) {
      if (!isElectronRequestChannel(channel)) {
        throw new Error(`Rejected unknown Electron request channel: ${describeChannel(channel)}`)
      }
      const params = args === undefined ? [channel] : [channel, args]
      return Promise.resolve(Reflect.apply(raw.invoke, raw, params))
    },
    on(channel, listener) {
      if (!isElectronEventChannel(channel)) {
        throw new Error(`Rejected unknown Electron event channel: ${describeChannel(channel)}`)
      }
      if (typeof listener !== 'function') {
        throw new Error(`Electron event listener for ${describeChannel(channel)} must be a function.`)
      }
      // One argument only, so an IpcRendererEvent cannot cross this boundary.
      const notify = listener as (payload: unknown) => void
      const dispose = Reflect.apply(raw.on, raw, [channel, (payload: unknown) => notify(payload)])
      if (typeof dispose !== 'function') {
        throw new Error(
          `Electron bridge on(${describeChannel(channel)}) must return a disposer function.`,
        )
      }
      return idempotent(dispose as ElectronDisposer)
    },
  }
}

function bridgeShapeError(detail: string): Error {
  return new Error(
    `Stride Electron bridge is missing or has the wrong shape: ${detail}. Expected globalThis[${JSON.stringify(ELECTRON_BRIDGE_KEY)}] to provide invoke(channel, args?) and on(channel, listener).`,
  )
}

function describeChannel(channel: unknown): string {
  if (typeof channel === 'string') return JSON.stringify(channel)
  if (channel === null) return 'null'
  return typeof channel
}

function idempotent(dispose: ElectronDisposer): ElectronDisposer {
  let settled = false
  return () => {
    if (settled) return
    settled = true
    dispose()
  }
}

function immutableSet<T extends string>(values: readonly T[]): ChannelSet<T> {
  if (new Set(values).size !== values.length) {
    throw new Error('Electron channel list contains duplicates')
  }
  const set = new Set<T>(values)
  const view: ChannelSet<T> = {
    get size() {
      return set.size
    },
    has(value: T): boolean {
      return set.has(value)
    },
    keys() {
      return set.keys()
    },
    values() {
      return set.values()
    },
    entries() {
      return set.entries()
    },
    forEach(callback, thisArg): void {
      for (const value of set) {
        callback.call(thisArg, value, value, view)
      }
    },
    [Symbol.iterator]() {
      return set[Symbol.iterator]()
    },
    get [Symbol.toStringTag]() {
      return 'Set'
    },
  }
  return Object.freeze(view)
}

export {
  decodeFileBytes,
  encodeFileBytes,
  homeDir,
  lstat,
  mkdir,
  pickDirectory,
  readDir,
  readFile,
  readTextFile,
  remove,
  rename,
  stat,
  watch,
  writeFile,
  writeTextFile,
  type DirEntry,
  type FileInfo,
  type MkdirOptions,
  type RemoveOptions,
  type WatchEvent,
  type WriteFileOptions,
} from './fs.ts'

export type { DeepLinkOpen } from './deep-link.ts'
export type {
  MenuCopy,
  RecentProject,
  SetProjectRequest,
  SyncRecentRequest,
  WindowIntent,
} from './windows.ts'
export { execGit, type GitExecResult } from './git.ts'
export { getOrCreateSealKey, type SealKeyRequest } from './secrets.ts'
export { cancelShell, onShellEvent, spawnShell, type ShellEvent, type ShellSpawnRequest } from './shell.ts'
export { killAgent, onAgentEvent, probeAgent, spawnAgent, whichAgents, writeAgent, type AgentEvent, type AgentExecutablePaths, type AgentSpawnRequest } from './agent-process.ts'
export { hostFetch } from './host-fetch.ts'
export type { HostFetchEvent, HostFetchHead, HostFetchRequest } from './host-fetch.ts'
export { listSystemFonts } from './fonts.ts'
export {
  checkForUpdate,
  downloadUpdate,
  installUpdate,
  onUpdaterEvent,
  relaunchAfterUpdate,
} from './updater.ts'
export type { UpdateOffer, UpdaterEvent } from './updater.ts'
