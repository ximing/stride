import { has, register, resolve } from '@rabjs/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseStaticUpdateManifest, setUpdaterDriverForTests, UpdateService, type UpdateQuery, type UpdaterDriver, type UpdaterUpdateInfo } from './update.service'
import { SettingsService } from '../settings/settings.service'
import { CommandService } from '../commands/command.service'
import {
  scheduleUpdateAutocheck,
  UpdateCheckService,
  UPDATE_AUTOCHECK_DELAY_MS,
  UPDATE_CHECK_FEEDBACK_CLEAR_MS,
} from './update-check'

// Keep in sync with DISMISSED_UPDATE_KEY in services/update/update.service.ts.
const DISMISSED_UPDATE_KEY = 'stride.update.dismissed'

class FakeUpdate implements UpdaterUpdateInfo {
  constructor(
    public version: string,
    public currentVersion: string,
    public body?: string,
    public date?: string,
  ) {}
  async download(): Promise<void> {}
  async install(): Promise<void> {}
}

function recordingDriver(update: UpdaterUpdateInfo | null) {
  const queries: (UpdateQuery | undefined)[] = []
  const driver: UpdaterDriver = {
    async check(query) {
      queries.push(query)
      return update
    },
    async relaunch() {},
  }
  return { driver, queries }
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

function freshSettings(): SettingsService {
  if (!has(SettingsService)) register(SettingsService)
  const settings = resolve(SettingsService)
  settings.form = {
    ...settings.form,
    releasesUrl: '',
    updates: { channel: 'stable', autoCheck: true },
  }
  return settings
}

function freshUpdateCheck(): UpdateCheckService {
  if (!has(UpdateCheckService)) register(UpdateCheckService)
  const service = resolve(UpdateCheckService)
  service.feedback = ''
  service.feedbackVersion = ''
  return service
}

describe('parseStaticUpdateManifest', () => {
  it('parses the GitHub release API shape', () => {
    const offer = parseStaticUpdateManifest(
      {
        tag_name: 'v0.2.0-beta.1',
        body: 'beta notes',
        published_at: '2026-10-16T00:00:00Z',
        html_url: 'https://github.com/ximing/stride/releases/tag/beta-latest',
      },
      '0.1.0',
    )
    expect(offer).toEqual({
      version: '0.2.0-beta.1',
      currentVersion: '0.1.0',
      body: 'beta notes',
      date: '2026-10-16T00:00:00Z',
      pageUrl: 'https://github.com/ximing/stride/releases/tag/beta-latest',
    })
  })

  it('parses the tauri static latest.json shape', () => {
    const offer = parseStaticUpdateManifest(
      { version: '0.2.0', notes: 'release notes', pub_date: '2026-10-16', platforms: {} },
      '0.1.0',
    )
    expect(offer?.version).toBe('0.2.0')
    expect(offer?.body).toBe('release notes')
    expect(offer?.date).toBe('2026-10-16')
  })

  it('returns null for older, equal, or malformed payloads', () => {
    expect(parseStaticUpdateManifest({ tag_name: 'v0.1.0' }, '0.1.0')).toBeNull()
    expect(parseStaticUpdateManifest({ version: '0.0.9' }, '0.1.0')).toBeNull()
    expect(parseStaticUpdateManifest(null, '0.1.0')).toBeNull()
    expect(parseStaticUpdateManifest('nope', '0.1.0')).toBeNull()
    expect(parseStaticUpdateManifest({}, '0.1.0')).toBeNull()
  })
})

describe('UpdateService channel routing (T8.3)', () => {
  beforeEach(() => {
    freshUpdates()
    freshSettings()
  })

  afterEach(() => {
    setUpdaterDriverForTests(null)
    localStorage.removeItem(DISMISSED_UPDATE_KEY)
  })

  it('passes the saved channel and trimmed custom endpoint to the driver', async () => {
    const settings = freshSettings()
    settings.form = {
      ...settings.form,
      updates: { channel: 'beta', autoCheck: true },
      releasesUrl: '',
    }
    const { driver, queries } = recordingDriver(null)
    setUpdaterDriverForTests(driver)
    await freshUpdates().check()
    expect(queries).toEqual([{ channel: 'beta', endpoint: '' }])

    settings.form = { ...settings.form, releasesUrl: '  https://example.com/latest.json  ' }
    Object.assign(resolve(UpdateService), { driver: null })
    await resolve(UpdateService).check()
    expect(queries[1]).toEqual({ channel: 'beta', endpoint: 'https://example.com/latest.json' })
  })

  it('defaults to the stable feed with no custom endpoint', async () => {
    const { driver, queries } = recordingDriver(null)
    setUpdaterDriverForTests(driver)
    await freshUpdates().check()
    expect(queries).toEqual([{ channel: 'stable', endpoint: '' }])
  })

  it('re-offers a dismissed version on a manual check only', async () => {
    const { driver } = recordingDriver(new FakeUpdate('0.2.0', '0.1.0'))
    setUpdaterDriverForTests(driver)
    localStorage.setItem(DISMISSED_UPDATE_KEY, '0.2.0')

    const updates = freshUpdates()
    await updates.check()
    expect(updates.phase).toBe('idle')

    Object.assign(updates, { driver: null })
    await updates.check({ ignoreDismissed: true })
    expect(updates.phase).toBe('available')
    expect(updates.version).toBe('0.2.0')
  })
})

describe('scheduleUpdateAutocheck (T8.3)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    freshSettings()
  })

  afterEach(() => {
    vi.useRealTimers()
    setUpdaterDriverForTests(null)
  })

  it('fires once after the default delay, not before', () => {
    const run = vi.fn()
    scheduleUpdateAutocheck({ run })
    vi.advanceTimersByTime(UPDATE_AUTOCHECK_DELAY_MS - 1)
    expect(run).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(run).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(UPDATE_AUTOCHECK_DELAY_MS * 2)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('does not run when the autoCheck switch is off at fire time', () => {
    const settings = freshSettings()
    settings.form = { ...settings.form, updates: { channel: 'stable', autoCheck: false } }
    const run = vi.fn()
    scheduleUpdateAutocheck({ run })
    vi.advanceTimersByTime(UPDATE_AUTOCHECK_DELAY_MS + 100)
    expect(run).not.toHaveBeenCalled()
  })

  it('honours the switch state at fire time, not at schedule time', () => {
    const settings = freshSettings()
    const run = vi.fn()
    scheduleUpdateAutocheck({ run })
    // Toggled off after scheduling but before the delay elapses.
    settings.form = { ...settings.form, updates: { channel: 'stable', autoCheck: false } }
    vi.advanceTimersByTime(UPDATE_AUTOCHECK_DELAY_MS)
    expect(run).not.toHaveBeenCalled()
  })

  it('cancel prevents the check', () => {
    const run = vi.fn()
    const cancel = scheduleUpdateAutocheck({ run })
    cancel()
    vi.advanceTimersByTime(UPDATE_AUTOCHECK_DELAY_MS + 100)
    expect(run).not.toHaveBeenCalled()
  })

  it('swallows a failing check silently', async () => {
    const run = vi.fn().mockRejectedValue(new Error('network unreachable'))
    scheduleUpdateAutocheck({ run })
    vi.advanceTimersByTime(UPDATE_AUTOCHECK_DELAY_MS)
    await vi.advanceTimersByTimeAsync(0)
    expect(run).toHaveBeenCalledTimes(1)
  })
})

describe('UpdateCheckService manual entries (T8.3)', () => {
  beforeEach(() => {
    freshUpdates()
    freshSettings()
    freshUpdateCheck()
  })

  afterEach(() => {
    setUpdaterDriverForTests(null)
    localStorage.removeItem(DISMISSED_UPDATE_KEY)
  })

  it('is a no-op where no updater can run (plain browser dev)', async () => {
    const service = freshUpdateCheck()
    expect(service.supported).toBe(false)
    await service.manualCheck()
    expect(service.feedback).toBe('')
  })

  it('reports up-to-date and clears the feedback line', async () => {
    vi.useFakeTimers()
    try {
      const { driver } = recordingDriver(null)
      setUpdaterDriverForTests(driver)
      const service = freshUpdateCheck()
      expect(service.supported).toBe(true)

      const pending = service.manualCheck()
      expect(service.feedback).toBe('checking')
      await pending
      expect(service.feedback).toBe('up-to-date')
      expect(service.feedbackText).toBe('已是最新')

      vi.advanceTimersByTime(UPDATE_CHECK_FEEDBACK_CLEAR_MS)
      expect(service.feedback).toBe('')
      expect(service.feedbackText).toBe('')
    } finally {
      vi.useRealTimers()
    }
  })

  it('points at the banner when an update is available', async () => {
    vi.useFakeTimers()
    try {
      const { driver } = recordingDriver(new FakeUpdate('0.2.0', '0.1.0'))
      setUpdaterDriverForTests(driver)
      const service = freshUpdateCheck()
      await service.manualCheck()
      expect(resolve(UpdateService).phase).toBe('available')
      expect(service.feedback).toBe('available')
      expect(service.feedbackText).toContain('v0.2.0')

      vi.advanceTimersByTime(UPDATE_CHECK_FEEDBACK_CLEAR_MS)
      expect(service.feedback).toBe('')
      // The banner (phase) is untouched by the feedback line clearing.
      expect(resolve(UpdateService).phase).toBe('available')
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not start a second check while one is in flight', async () => {
    const { driver, queries } = recordingDriver(null)
    setUpdaterDriverForTests(driver)
    const updates = freshUpdates()
    updates.phase = 'checking'
    const service = freshUpdateCheck()
    await service.manualCheck()
    expect(service.feedback).toBe('checking')
    expect(queries).toHaveLength(0)
  })

  it('clears the busy acknowledgement by itself so the button never sticks', async () => {
    vi.useFakeTimers()
    try {
      setUpdaterDriverForTests(recordingDriver(null).driver)
      const updates = freshUpdates()
      // Another flow (banner download) owns the service for the foreseeable
      // future; manualCheck must not leave "checking" up forever.
      updates.phase = 'downloading'
      const service = freshUpdateCheck()
      await service.manualCheck()
      expect(service.feedback).toBe('checking')
      vi.advanceTimersByTime(UPDATE_CHECK_FEEDBACK_CLEAR_MS)
      expect(service.feedback).toBe('')
      expect(service.feedbackText).toBe('')
      expect(updates.phase).toBe('downloading')
    } finally {
      vi.useRealTimers()
    }
  })

  it('backs the palette command with the same manual check', async () => {
    const { driver } = recordingDriver(null)
    setUpdaterDriverForTests(driver)
    if (!has(CommandService)) register(CommandService)
    const commands = resolve(CommandService)
    expect(commands.isRunnable('app.checkForUpdates')).toBe(true)
    expect(commands.execute('app.checkForUpdates')).toBe(true)
    await vi.waitFor(() => {
      expect(resolve(UpdateCheckService).feedback).toBe('up-to-date')
    })
  })

  it('greys out the palette command where no updater can run', () => {
    if (!has(CommandService)) register(CommandService)
    expect(resolve(CommandService).isRunnable('app.checkForUpdates')).toBe(false)
  })
})
