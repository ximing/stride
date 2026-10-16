import { has, register, resolve } from '@rabjs/react'
import { compareVersions } from '@stride/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  setUpdaterDriverForTests,
  UpdateService,
  type UpdaterDownloadEvent,
  type UpdaterDriver,
  type UpdaterUpdateInfo,
} from './panels.service'

// Keep in sync with DISMISSED_UPDATE_KEY in panels.service.ts.
const DISMISSED_UPDATE_KEY = 'stride.update.dismissed'

class FakeUpdate implements UpdaterUpdateInfo {
  body?: string
  date?: string
  downloaded = false
  installed = false
  failDownload: unknown = null
  failInstall: unknown = null
  events: UpdaterDownloadEvent[] = []

  constructor(
    public version: string,
    public currentVersion: string,
    extras: { body?: string; date?: string } = {},
  ) {
    this.body = extras.body
    this.date = extras.date
  }

  async download(onEvent?: (event: UpdaterDownloadEvent) => void): Promise<void> {
    if (this.failDownload) throw this.failDownload
    for (const event of this.events) onEvent?.(event)
    this.downloaded = true
  }

  async install(): Promise<void> {
    if (this.failInstall) throw this.failInstall
    this.installed = true
  }
}

function fakeDriver(update: UpdaterUpdateInfo | null) {
  const calls: string[] = []
  const driver: UpdaterDriver & { calls: string[] } = {
    calls,
    async check() {
      calls.push('check')
      return update
    },
    async relaunch() {
      calls.push('relaunch')
    },
  }
  return driver
}

function freshUpdates(): UpdateService {
  if (!has(UpdateService)) register(UpdateService)
  const updates = resolve(UpdateService)
  Object.assign(updates, {
    phase: 'idle',
    progress: 0,
    version: '',
    current: '',
    error: '',
    body: '',
    date: '',
    pending: null,
    expectedVersion: '',
    driver: null,
  })
  return updates
}

describe('compareVersions', () => {
  it('orders versions with tolaria semantics', () => {
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0)
    expect(compareVersions('1.2.4', '1.2.3')).toBe(1)
    expect(compareVersions('1.2.3', '1.2.4')).toBe(-1)
    expect(compareVersions('2.0.0', '10.0.0')).toBe(-1)
    expect(compareVersions('0.10.0', '0.9.9')).toBe(1)
  })

  it('accepts v-prefixed tags and missing segments', () => {
    expect(compareVersions('v1.2.3', '1.2.3')).toBe(0)
    expect(compareVersions('v0.2', '0.1.9')).toBe(1)
    expect(compareVersions('1', '1.0.0')).toBe(0)
    expect(compareVersions('1.0.1+build5', '1.0.0')).toBe(1)
  })
})

describe('UpdateService', () => {
  afterEach(() => {
    setUpdaterDriverForTests(null)
    localStorage.removeItem(DISMISSED_UPDATE_KEY)
  })

  it('stays idle outside Tauri when no driver exists', async () => {
    const updates = freshUpdates()
    await updates.check()
    expect(updates.phase).toBe('idle')
    expect(updates.error).toBe('')
  })

  it('moves to available when the endpoint offers a newer version', async () => {
    const updates = freshUpdates()
    const update = new FakeUpdate('0.2.0', '0.1.0', { body: 'release notes', date: '2026-10-16' })
    setUpdaterDriverForTests(fakeDriver(update))
    await updates.check()
    expect(updates.phase).toBe('available')
    expect(updates.version).toBe('0.2.0')
    expect(updates.current).toBe('0.1.0')
    expect(updates.body).toBe('release notes')
    expect(updates.date).toBe('2026-10-16')
    expect(updates.error).toBe('')
  })

  it('stays idle when no update is returned', async () => {
    const updates = freshUpdates()
    setUpdaterDriverForTests(fakeDriver(null))
    await updates.check()
    expect(updates.phase).toBe('idle')
  })

  it('refuses downgrades and same-version offers', async () => {
    const updates = freshUpdates()
    setUpdaterDriverForTests(fakeDriver(new FakeUpdate('0.0.9', '0.1.0')))
    await updates.check()
    expect(updates.phase).toBe('idle')
    expect(updates.version).toBe('')

    setUpdaterDriverForTests(fakeDriver(new FakeUpdate('0.1.0', '0.1.0')))
    await updates.check()
    expect(updates.phase).toBe('idle')
  })

  it('swallows network errors during check', async () => {
    const updates = freshUpdates()
    setUpdaterDriverForTests({
      async check() {
        throw new Error('network unreachable')
      },
      async relaunch() {},
    })
    await updates.check()
    expect(updates.phase).toBe('idle')
    expect(updates.error).toBe('')
  })

  it('downloads with progress and confirms with install plus relaunch', async () => {
    const updates = freshUpdates()
    const update = new FakeUpdate('0.2.0', '0.1.0')
    update.events = [
      { event: 'Started', data: { contentLength: 100 } },
      { event: 'Progress', data: { chunkLength: 40 } },
      { event: 'Progress', data: { chunkLength: 60 } },
      { event: 'Finished' },
    ]
    const driver = fakeDriver(update)
    setUpdaterDriverForTests(driver)

    await updates.check()
    expect(updates.phase).toBe('available')

    const progressSpy = vi.fn()
    const seen: number[] = []
    progressSpy.mockImplementation(() => seen.push(updates.progress))

    await updates.download()
    expect(update.downloaded).toBe(true)
    expect(updates.phase).toBe('ready')
    expect(updates.progress).toBe(1)

    await updates.confirm()
    expect(update.installed).toBe(true)
    expect(driver.calls).toEqual(['check', 'relaunch'])
  })

  it('tracks fractional progress from chunk events', async () => {
    const updates = freshUpdates()
    const update = new FakeUpdate('0.2.0', '0.1.0')
    const observed: number[] = []
    update.events = [
      { event: 'Started', data: { contentLength: 200 } },
      { event: 'Progress', data: { chunkLength: 50 } },
      { event: 'Progress', data: { chunkLength: 100 } },
      { event: 'Finished' },
    ]
    const originalDownload = update.download.bind(update)
    update.download = async (onEvent) => {
      await originalDownload((event) => {
        onEvent?.(event)
        observed.push(updates.progress)
      })
    }
    setUpdaterDriverForTests(fakeDriver(update))
    await updates.check()
    await updates.download()
    expect(observed).toEqual([0, 0.25, 0.75, 1])
    expect(updates.phase).toBe('ready')
  })

  it('returns to idle silently when the download fails', async () => {
    const updates = freshUpdates()
    const update = new FakeUpdate('0.2.0', '0.1.0')
    update.failDownload = new Error('connection reset')
    setUpdaterDriverForTests(fakeDriver(update))
    await updates.check()
    await updates.download()
    expect(updates.phase).toBe('idle')
    expect(updates.error).toBe('')
    expect(updates.progress).toBe(0)
  })

  it('flags an error when the downloaded build drifts from the expected version', async () => {
    const updates = freshUpdates()
    const update = new FakeUpdate('0.2.0', '0.1.0')
    const originalDownload = update.download.bind(update)
    update.download = async (onEvent) => {
      await originalDownload(onEvent)
      update.version = '0.3.0'
    }
    setUpdaterDriverForTests(fakeDriver(update))
    await updates.check()
    await updates.download()
    expect(updates.phase).toBe('error')
    expect(updates.error).toBe('Update verification failed')
    expect(update.installed).toBe(false)
  })

  it('refuses to install a downgrade at confirm time', async () => {
    const updates = freshUpdates()
    const update = new FakeUpdate('0.2.0', '0.1.0')
    setUpdaterDriverForTests(fakeDriver(update))
    await updates.check()
    await updates.download()
    expect(updates.phase).toBe('ready')
    update.version = '0.0.1'
    await updates.confirm()
    expect(updates.phase).toBe('error')
    expect(updates.error).toBe('Update verification failed')
    expect(update.installed).toBe(false)
  })

  it('surfaces install failures as errors without relaunching', async () => {
    const updates = freshUpdates()
    const update = new FakeUpdate('0.2.0', '0.1.0')
    update.failInstall = new Error('signature mismatch')
    const driver = fakeDriver(update)
    setUpdaterDriverForTests(driver)
    await updates.check()
    await updates.download()
    await updates.confirm()
    expect(updates.phase).toBe('error')
    expect(updates.error).toBe('signature mismatch')
    expect(driver.calls).toEqual(['check'])
  })

  it('dismisses a version and does not offer it again', async () => {
    const updates = freshUpdates()
    const update = new FakeUpdate('0.2.0', '0.1.0')
    setUpdaterDriverForTests(fakeDriver(update))
    await updates.check()
    expect(updates.phase).toBe('available')
    updates.dismiss()
    expect(updates.phase).toBe('idle')
    expect(updates.version).toBe('')
    expect(localStorage.getItem(DISMISSED_UPDATE_KEY)).toBe('0.2.0')

    Object.assign(updates, { pending: null, expectedVersion: '', driver: null })
    await updates.check()
    expect(updates.phase).toBe('idle')
    expect(updates.version).toBe('')
  })

  it('offers a newer version even after an older one was dismissed', async () => {
    const updates = freshUpdates()
    localStorage.setItem(DISMISSED_UPDATE_KEY, '0.2.0')
    setUpdaterDriverForTests(fakeDriver(new FakeUpdate('0.3.0', '0.1.0')))
    await updates.check()
    expect(updates.phase).toBe('available')
    expect(updates.version).toBe('0.3.0')
  })
})
