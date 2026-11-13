// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { registerHostUpdater, resetHostUpdaterState, type HostAutoUpdater, type UpdaterIpcEvent } from './updater.ts'
import type { RendererTrust } from './security.ts'

const DEV = 'http://127.0.0.1:1421/'
const trust: RendererTrust = { packaged: false, devUrl: DEV }

interface FakeUpdater extends HostAutoUpdater {
  emit(event: string, payload?: unknown): void
  check: ReturnType<typeof vi.fn>
  download: ReturnType<typeof vi.fn>
  install: ReturnType<typeof vi.fn>
}

function fakeUpdater(): FakeUpdater {
  const listeners = new Map<string, Set<(payload: unknown) => void>>()
  const updater = {
    autoDownload: true,
    check: vi.fn(async () => null),
    download: vi.fn(async () => []),
    install: vi.fn(),
    checkForUpdates() {
      return updater.check()
    },
    downloadUpdate() {
      return updater.download()
    },
    quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean) {
      updater.install(isSilent, isForceRunAfter)
    },
    on(event: string, listener: (payload: unknown) => void) {
      const bucket = listeners.get(event) ?? new Set()
      bucket.add(listener)
      listeners.set(event, bucket)
      return updater
    },
    removeListener(event: string, listener: (payload: unknown) => void) {
      listeners.get(event)?.delete(listener)
    },
    emit(event: string, payload?: unknown) {
      for (const listener of listeners.get(event) ?? []) listener(payload)
    },
  }
  return updater
}

describe('stable updater', () => {
  let handlers: Map<string, (event: UpdaterIpcEvent, payload?: unknown) => unknown>
  let updater: FakeUpdater
  let relaunched: number[]
  let exits: number[]
  let packaged: boolean
  let version: string

  beforeEach(() => {
    resetHostUpdaterState()
    handlers = new Map()
    updater = fakeUpdater()
    relaunched = []
    exits = []
    packaged = true
    version = '1.0.0'
    registerHostUpdater({
      handle(channel, listener) {
        handlers.set(channel, listener)
      },
      getTrust: () => trust,
      isPackaged: () => packaged,
      currentVersion: () => version,
      relaunch: () => {
        relaunched.push(1)
      },
      exit: (code) => {
        exits.push(code)
      },
      autoUpdater: updater,
    })
  })

  function sender() {
    const sent: unknown[] = []
    return {
      sent,
      event: {
        sender: {
          getURL: () => DEV,
          isDestroyed: () => false,
          send(_channel: string, payload: unknown) {
            sent.push(payload)
          },
        },
      } satisfies UpdaterIpcEvent,
    }
  }

  function call(channel: string, event: UpdaterIpcEvent) {
    const handler = handlers.get(channel)
    if (!handler) throw new Error(`missing ${channel}`)
    return handler(event)
  }

  it('returns null when no update is available and does not log the check', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    updater.check.mockResolvedValue({ isUpdateAvailable: false, updateInfo: { version: '1.0.0' } })
    const box = sender()
    await expect(call('updater:check', box.event)).resolves.toBeNull()
    expect(updater.autoDownload).toBe(false)
    expect(log).not.toHaveBeenCalled()
    expect(info).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
    log.mockRestore()
    info.mockRestore()
    error.mockRestore()
  })

  it('saves an offer with version, notes, date, and the current version', async () => {
    updater.check.mockResolvedValue({
      isUpdateAvailable: true,
      updateInfo: {
        version: '1.2.0',
        releaseDate: '2026-11-01',
        releaseNotes: [{ note: 'Fixes' }, 'and notes'],
        files: [{ url: 'https://example.invalid/Stride.zip' }],
      },
    })
    const box = sender()
    await expect(call('updater:check', box.event)).resolves.toEqual({
      version: '1.2.0',
      body: 'Fixes\nand notes',
      date: '2026-11-01',
      currentVersion: '1.0.0',
    })
    expect(JSON.stringify(box.sent)).not.toContain('https://')
  })

  it('sends download progress only to the requesting sender', async () => {
    updater.check.mockResolvedValue({
      isUpdateAvailable: true,
      updateInfo: { version: '1.2.0', releaseNotes: 'body', releaseDate: '2026-11-01' },
    })
    updater.download.mockImplementation(async () => {
      updater.emit('download-progress', { percent: 40, transferred: 4, total: 10 })
      return ['/tmp/Stride.zip']
    })
    const first = sender()
    const other = sender()
    await call('updater:check', first.event)
    await call('updater:download', first.event)
    expect(first.sent).toEqual([
      { type: 'Started', version: '1.2.0' },
      { type: 'Progress', version: '1.2.0', percent: 40, transferred: 4, total: 10 },
      { type: 'Finished', version: '1.2.0' },
    ])
    expect(other.sent).toEqual([])
    expect(JSON.stringify(first.sent)).not.toContain('/tmp/')
  })

  it('refuses install when nothing was downloaded, the offer drifted, or the version is older', async () => {
    const box = sender()
    await expect(call('updater:install', box.event)).rejects.toThrow(/not downloaded/)

    updater.check.mockResolvedValue({
      isUpdateAvailable: true,
      updateInfo: { version: '1.2.0', releaseNotes: null, releaseDate: null },
    })
    updater.download.mockResolvedValue([])
    await call('updater:check', box.event)
    await call('updater:download', box.event)
    updater.check.mockResolvedValue({
      isUpdateAvailable: true,
      updateInfo: { version: '1.3.0', releaseNotes: null, releaseDate: null },
    })
    await call('updater:check', box.event)
    await expect(call('updater:install', box.event)).rejects.toThrow(/version changed/)
    expect(updater.install).not.toHaveBeenCalled()

    resetHostUpdaterState()
    handlers.clear()
    version = '1.0.0'
    registerHostUpdater({
      handle(channel, listener) {
        handlers.set(channel, listener)
      },
      getTrust: () => trust,
      isPackaged: () => true,
      currentVersion: () => version,
      relaunch: () => undefined,
      exit: () => undefined,
      autoUpdater: updater,
    })
    updater.check.mockResolvedValue({
      isUpdateAvailable: true,
      updateInfo: { version: '1.2.0', releaseNotes: null, releaseDate: null },
    })
    const again = sender()
    await call('updater:check', again.event)
    await call('updater:download', again.event)
    version = '2.0.0'
    await expect(call('updater:install', again.event)).rejects.toThrow(/older version/)
    expect(updater.install).not.toHaveBeenCalled()
  })

  it('does not save an offer that is not newer than the current version', async () => {
    updater.check.mockResolvedValue({
      isUpdateAvailable: true,
      updateInfo: { version: '1.0.0', releaseNotes: 'same', releaseDate: '2026-11-01' },
    })
    const box = sender()
    await expect(call('updater:check', box.event)).resolves.toBeNull()
    await expect(call('updater:download', box.event)).rejects.toThrow(/No update to download/)
  })

  it('refuses to install the same version that is already current', async () => {
    updater.check.mockResolvedValue({
      isUpdateAvailable: true,
      updateInfo: { version: '1.2.0', releaseNotes: null, releaseDate: null },
    })
    updater.download.mockResolvedValue([])
    const box = sender()
    await call('updater:check', box.event)
    await call('updater:download', box.event)
    version = '1.2.0'
    await expect(call('updater:install', box.event)).rejects.toThrow(/same version/)
    expect(updater.install).not.toHaveBeenCalled()
  })

  it('installs only the downloaded offer and relaunches through the app', async () => {
    updater.check.mockResolvedValue({
      isUpdateAvailable: true,
      updateInfo: { version: '1.2.0', releaseNotes: 'ok', releaseDate: '2026-11-01' },
    })
    updater.download.mockResolvedValue([])
    const box = sender()
    await call('updater:check', box.event)
    await call('updater:download', box.event)
    await call('updater:install', box.event)
    expect(updater.install).toHaveBeenCalledWith(false, false)
    call('updater:relaunch', box.event)
    expect(relaunched).toEqual([1])
    expect(exits).toEqual([0])
  })

  it('does not contact the updater while unpackaged', async () => {
    packaged = false
    const box = sender()
    await expect(call('updater:check', box.event)).resolves.toBeNull()
    expect(updater.check).not.toHaveBeenCalled()
    await expect(call('updater:download', box.event)).rejects.toThrow(/No update to download/)
  })

  it('replaces check and download failures so the feed url stays off the error', async () => {
    const feed = 'https://github.com/ximing/stride/releases.atom'
    updater.check.mockRejectedValue(new Error(`net::ERR_FAILED ${feed}`))
    const box = sender()
    await expect(call('updater:check', box.event)).rejects.toThrow(/^Update check failed$/)
    updater.check.mockResolvedValue({
      isUpdateAvailable: true,
      updateInfo: { version: '1.2.0', releaseNotes: null, releaseDate: null },
    })
    await call('updater:check', box.event)
    updater.download.mockRejectedValue(new Error(`Cannot download ${feed}`))
    await expect(call('updater:download', box.event)).rejects.toThrow(/^Update download failed$/)
    expect(JSON.stringify(box.sent)).not.toContain(feed)
    expect(JSON.stringify(box.sent)).not.toContain('github.com')
  })

  it('rejects an untrusted sender before using the updater', async () => {
    const event: UpdaterIpcEvent = {
      sender: {
        getURL: () => 'https://evil.example/',
        isDestroyed: () => false,
        send: () => undefined,
      },
    }
    await expect(call('updater:check', event)).rejects.toThrow(/untrusted/i)
    expect(updater.check).not.toHaveBeenCalled()
  })
})
