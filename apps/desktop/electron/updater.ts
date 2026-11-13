import { createRequire } from 'node:module'
import { assertTrustedSender, type RendererTrust, type TrustedSenderEvent } from './security.ts'

export interface UpdateOffer {
  version: string
  body: string | null
  date: string | null
  currentVersion: string
}

export interface UpdateInfoLike {
  version?: unknown
  releaseDate?: unknown
  releaseNotes?: unknown
}

export interface UpdateCheckLike {
  isUpdateAvailable?: boolean
  updateInfo?: UpdateInfoLike | null
}

export interface HostAutoUpdater {
  autoDownload: boolean
  checkForUpdates(): Promise<UpdateCheckLike | null | undefined>
  downloadUpdate(): Promise<unknown>
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
  on(event: string, listener: (payload: unknown) => void): unknown
  removeListener(event: string, listener: (payload: unknown) => void): unknown
}

export interface UpdaterSender {
  getURL(): string
  send(channel: string, payload: unknown): void
  isDestroyed(): boolean
}

export interface UpdaterIpcEvent {
  sender: UpdaterSender
}

export interface HostUpdaterDeps {
  handle(channel: string, listener: (event: UpdaterIpcEvent, payload?: unknown) => unknown): void
  getTrust(): RendererTrust
  isPackaged(): boolean
  currentVersion(): string
  relaunch(): void
  exit(code: number): void
  autoUpdater?: HostAutoUpdater
}

let offer: UpdateOffer | null = null
let downloadedVersion: string | null = null
let downloading = false

export function resetHostUpdaterState(): void {
  offer = null
  downloadedVersion = null
  downloading = false
}

function notesOf(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return null
  const parts: string[] = []
  for (const item of value) {
    if (typeof item === 'string') parts.push(item)
    else if (item && typeof item === 'object' && typeof (item as { note?: unknown }).note === 'string') {
      parts.push((item as { note: string }).note)
    }
  }
  return parts.length > 0 ? parts.join('\n') : null
}

function versionParts(value: string): number[] {
  const core = value.trim().replace(/^v/i, '').split('-')[0] ?? ''
  return core.split('.').map((part) => {
    const match = /^(\d+)/.exec(part)
    return match ? Number(match[1]) : 0
  })
}

export function compareVersions(left: string, right: string): number {
  const a = versionParts(left)
  const b = versionParts(right)
  const length = Math.max(a.length, b.length)
  for (let index = 0; index < length; index += 1) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0)
    if (delta !== 0) return delta
  }
  return 0
}

function offerFrom(result: UpdateCheckLike | null | undefined, currentVersion: string): UpdateOffer | null {
  if (!result?.isUpdateAvailable || !result.updateInfo) return null
  const version = result.updateInfo.version
  if (typeof version !== 'string' || version.trim().length === 0) return null
  const trimmed = version.trim()
  if (compareVersions(trimmed, currentVersion) <= 0) return null
  const date = result.updateInfo.releaseDate
  return {
    version: trimmed,
    body: notesOf(result.updateInfo.releaseNotes),
    date: typeof date === 'string' ? date : null,
    currentVersion,
  }
}

function send(sender: UpdaterSender, payload: unknown): void {
  if (sender.isDestroyed()) return
  sender.send('updater:event', payload)
}

function progressOf(payload: unknown): { percent: number; transferred: number; total: number } {
  const record = payload && typeof payload === 'object' ? payload as { percent?: unknown; transferred?: unknown; total?: unknown } : {}
  return {
    percent: typeof record.percent === 'number' ? record.percent : 0,
    transferred: typeof record.transferred === 'number' ? record.transferred : 0,
    total: typeof record.total === 'number' ? record.total : 0,
  }
}

function loadAutoUpdater(): HostAutoUpdater {
  // Resolve the runtime dependency from this packaged CJS entry. Function()
  // evaluates outside the module scope and cannot see its local require.
  const runtimeRequire = createRequire(__filename) as (id: string) => { autoUpdater: HostAutoUpdater }
  const loaded = runtimeRequire(['electron', 'updater'].join('-'))
  loaded.autoUpdater.autoDownload = false
  return loaded.autoUpdater
}

function updaterOf(deps: HostUpdaterDeps): HostAutoUpdater {
  const updater = deps.autoUpdater ?? loadAutoUpdater()
  updater.autoDownload = false
  return updater
}

/** Stable GitHub updater. Unpackaged builds report no update and never contact a server. */
export function registerHostUpdater(deps: HostUpdaterDeps): void {
  resetHostUpdaterState()
  let updater: HostAutoUpdater | null = null
  const active = (): HostAutoUpdater => {
    if (!updater) updater = updaterOf(deps)
    return updater
  }

  deps.handle('updater:check', async (event) => {
    assertTrustedSender(event as TrustedSenderEvent, deps.getTrust())
    if (!deps.isPackaged()) return null
    try {
      const result = await active().checkForUpdates()
      offer = offerFrom(result, deps.currentVersion())
      return offer
    } catch {
      throw new Error('Update check failed')
    }
  })

  deps.handle('updater:download', async (event) => {
    assertTrustedSender(event as TrustedSenderEvent, deps.getTrust())
    if (!offer) throw new Error('No update to download')
    if (downloading) throw new Error('Update download already in progress')
    const version = offer.version
    const sender = event.sender
    downloading = true
    const onProgress = (payload: unknown) => {
      const progress = progressOf(payload)
      send(sender, { type: 'Progress', version, ...progress })
    }
    active().on('download-progress', onProgress)
    try {
      send(sender, { type: 'Started', version })
      await active().downloadUpdate()
      downloadedVersion = version
      send(sender, { type: 'Finished', version })
    } catch {
      throw new Error('Update download failed')
    } finally {
      downloading = false
      active().removeListener('download-progress', onProgress)
    }
  })

  deps.handle('updater:install', async (event) => {
    assertTrustedSender(event as TrustedSenderEvent, deps.getTrust())
    if (!offer || downloadedVersion === null) throw new Error('Update is not downloaded')
    if (downloadedVersion !== offer.version) throw new Error('Update version changed')
    if (compareVersions(offer.version, deps.currentVersion()) < 0) throw new Error('Refusing to install an older version')
    if (compareVersions(offer.version, deps.currentVersion()) === 0) throw new Error('Refusing to install the same version')
    // quitAndInstall exits and starts the installer. Do not also relaunch.
    active().quitAndInstall(false, false)
  })

  // Separate IPC. The stable confirm path must not call this after install.
  deps.handle('updater:relaunch', (event) => {
    assertTrustedSender(event as TrustedSenderEvent, deps.getTrust())
    deps.relaunch()
    deps.exit(0)
  })
}
