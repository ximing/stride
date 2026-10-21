import { has, register, resolve } from '@rabjs/react'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setUpdaterDriverForTests, UpdateService, type UpdaterDownloadEvent, type UpdaterDriver, type UpdaterUpdateInfo } from '../../services/update/update.service'
import { UpdateBanner } from './update-banner'

// Keep in sync with DISMISSED_UPDATE_KEY in services/update/update.service.ts.
const DISMISSED_UPDATE_KEY = 'stride.update.dismissed'

class FakeUpdate implements UpdaterUpdateInfo {
  body?: string
  date?: string
  downloaded = false
  installed = false
  failInstall: unknown = null
  events: UpdaterDownloadEvent[] = []
  // When set, download() waits on this deferred instead of resolving itself,
  // so tests can observe the mid-download UI.
  gate: { promise: Promise<void>; resolve: () => void } | null = null

  constructor(
    public version: string,
    public currentVersion: string,
    extras: { body?: string; date?: string } = {},
  ) {
    this.body = extras.body
    this.date = extras.date
  }

  async download(onEvent?: (event: UpdaterDownloadEvent) => void): Promise<void> {
    for (const event of this.events) onEvent?.(event)
    if (this.gate) await this.gate.promise
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

function host(): { host: HTMLDivElement; root: Root } {
  const element = document.createElement('div')
  document.body.appendChild(element)
  return { host: element, root: createRoot(element) }
}

async function render(root: Root, node: ReactNode) {
  await act(async () => {
    root.render(node)
  })
}

async function unmount(element: HTMLDivElement, root: Root) {
  await act(async () => {
    root.unmount()
  })
  element.remove()
}

describe('UpdateBanner', () => {
  afterEach(() => {
    setUpdaterDriverForTests(null)
    localStorage.removeItem(DISMISSED_UPDATE_KEY)
  })

  it('renders nothing while idle, and stays silent while checking', async () => {
    const updates = freshUpdates()
    const { host: element, root } = host()
    try {
      await render(root, <UpdateBanner />)
      expect(element.querySelector('[data-testid="update-banner"]')).toBeNull()

      // A check that never resolves keeps the service in `checking`.
      setUpdaterDriverForTests({
        check: () => new Promise<UpdaterUpdateInfo | null>(() => {}),
        async relaunch() {},
      })
      let checking!: Promise<void>
      await act(async () => {
        checking = updates.check()
        await Promise.resolve()
      })
      expect(updates.phase).toBe('checking')
      expect(element.querySelector('[data-testid="update-banner"]')).toBeNull()
      void checking
    } finally {
      await unmount(element, root)
    }
  })

  it('offers the new version with release notes and a download button', async () => {
    const updates = freshUpdates()
    const update = new FakeUpdate('0.2.0', '0.1.0', { body: 'fix one\nfix two', date: '2026-10-16' })
    setUpdaterDriverForTests(fakeDriver(update))
    const { host: element, root } = host()
    try {
      await render(root, <UpdateBanner />)
      await act(async () => {
        await updates.check()
      })
      const banner = element.querySelector('[data-testid="update-banner"]')!
      expect(banner.getAttribute('data-phase')).toBe('available')
      expect(banner.textContent).toContain('v0.2.0')
      expect(banner.textContent).toContain('当前 v0.1.0')
      expect(banner.textContent).toContain('2026-10-16')
      const notes = element.querySelector('[data-testid="update-notes"]')!
      expect(notes.textContent).toContain('fix one')
      expect(notes.textContent).toContain('fix two')
      // Short notes need no collapse toggle.
      expect(element.querySelector('[data-testid="update-notes-toggle"]')).toBeNull()

      await act(async () => {
        element.querySelector<HTMLButtonElement>('[data-testid="update-download"]')!.click()
      })
      expect(update.downloaded).toBe(true)
      expect(updates.phase).toBe('ready')
    } finally {
      await unmount(element, root)
    }
  })

  it('collapses long release notes behind a toggle', async () => {
    const updates = freshUpdates()
    const body = Array.from({ length: 8 }, (_, i) => `line ${i + 1}`).join('\n')
    setUpdaterDriverForTests(fakeDriver(new FakeUpdate('0.2.0', '0.1.0', { body })))
    const { host: element, root } = host()
    try {
      await render(root, <UpdateBanner />)
      await act(async () => {
        await updates.check()
      })
      const notes = element.querySelector('[data-testid="update-notes"]')!
      expect(notes.textContent).toContain('line 4')
      expect(notes.textContent).not.toContain('line 5')
      await act(async () => {
        element.querySelector<HTMLButtonElement>('[data-testid="update-notes-toggle"]')!.click()
      })
      expect(element.querySelector('[data-testid="update-notes"]')!.textContent).toContain('line 8')
    } finally {
      await unmount(element, root)
    }
  })

  it('remembers a dismissed version and hides the banner', async () => {
    const updates = freshUpdates()
    setUpdaterDriverForTests(fakeDriver(new FakeUpdate('0.2.0', '0.1.0')))
    const { host: element, root } = host()
    try {
      await render(root, <UpdateBanner />)
      await act(async () => {
        await updates.check()
      })
      expect(element.querySelector('[data-testid="update-banner"]')).not.toBeNull()
      await act(async () => {
        element.querySelector<HTMLButtonElement>('[data-testid="update-dismiss"]')!.click()
      })
      expect(updates.phase).toBe('idle')
      expect(localStorage.getItem(DISMISSED_UPDATE_KEY)).toBe('0.2.0')
      expect(element.querySelector('[data-testid="update-banner"]')).toBeNull()
    } finally {
      await unmount(element, root)
    }
  })

  it('shows background progress while downloading, then offers restart', async () => {
    const updates = freshUpdates()
    const update = new FakeUpdate('0.2.0', '0.1.0')
    let release!: () => void
    update.gate = { promise: new Promise<void>((done) => (release = done)), resolve: () => release() }
    update.events = [
      { event: 'Started', data: { contentLength: 100 } },
      { event: 'Progress', data: { chunkLength: 40 } },
    ]
    const driver = fakeDriver(update)
    setUpdaterDriverForTests(driver)
    const { host: element, root } = host()
    try {
      await render(root, <UpdateBanner />)
      await act(async () => {
        await updates.check()
      })
      await act(async () => {
        element.querySelector<HTMLButtonElement>('[data-testid="update-download"]')!.click()
        await Promise.resolve()
      })
      expect(updates.phase).toBe('downloading')
      const banner = element.querySelector('[data-testid="update-banner"]')!
      expect(banner.getAttribute('data-phase')).toBe('downloading')
      expect(banner.textContent).toContain('后台下载中')
      const progress = element.querySelector('[data-testid="update-progress"]')!
      expect(progress.getAttribute('aria-valuenow')).toBe('40')
      expect(element.querySelector('[data-testid="update-progress-percent"]')!.textContent).toBe('40%')
      // Downloading must not nag with action buttons.
      expect(element.querySelector('[data-testid="update-dismiss"]')).toBeNull()

      await act(async () => {
        release()
      })
      expect(updates.phase).toBe('ready')
      const restart = element.querySelector<HTMLButtonElement>('[data-testid="update-restart"]')!
      expect(restart.textContent).toBe('重启以更新到 v0.2.0')
      await act(async () => {
        restart.click()
      })
      expect(update.installed).toBe(true)
      expect(driver.calls).toEqual(['check', 'relaunch'])
    } finally {
      await unmount(element, root)
    }
  })

  it('snoozes the ready banner without dismissing the version', async () => {
    const updates = freshUpdates()
    const update = new FakeUpdate('0.2.0', '0.1.0')
    setUpdaterDriverForTests(fakeDriver(update))
    const { host: element, root } = host()
    try {
      await render(root, <UpdateBanner />)
      await act(async () => {
        await updates.check()
        await updates.download()
      })
      expect(updates.phase).toBe('ready')
      await act(async () => {
        element.querySelector<HTMLButtonElement>('[data-testid="update-later"]')!.click()
      })
      // Hidden, but the update stays ready and is not remembered as dismissed.
      expect(element.querySelector('[data-testid="update-banner"]')).toBeNull()
      expect(updates.phase).toBe('ready')
      expect(localStorage.getItem(DISMISSED_UPDATE_KEY)).toBeNull()
    } finally {
      await unmount(element, root)
    }
  })

  it('surfaces install failures with retry and close actions', async () => {
    const updates = freshUpdates()
    const update = new FakeUpdate('0.2.0', '0.1.0')
    update.failInstall = new Error('signature mismatch')
    const driver = fakeDriver(update)
    setUpdaterDriverForTests(driver)
    const { host: element, root } = host()
    try {
      await render(root, <UpdateBanner />)
      await act(async () => {
        await updates.check()
        await updates.download()
        await updates.confirm()
      })
      expect(updates.phase).toBe('error')
      const banner = element.querySelector('[data-testid="update-banner"]')!
      expect(banner.getAttribute('data-phase')).toBe('error')
      expect(element.querySelector('[data-testid="update-error"]')!.textContent).toContain('signature mismatch')

      await act(async () => {
        element.querySelector<HTMLButtonElement>('[data-testid="update-retry"]')!.click()
      })
      // Retry re-runs the silent check; the same offer comes back.
      expect(driver.calls).toEqual(['check', 'check'])
      expect(updates.phase).toBe('available')

      // Fail again, then close the banner entirely.
      await act(async () => {
        await updates.download()
        await updates.confirm()
      })
      expect(updates.phase).toBe('error')
      await act(async () => {
        element.querySelector<HTMLButtonElement>('[data-testid="update-close"]')!.click()
      })
      expect(updates.phase).toBe('idle')
      expect(element.querySelector('[data-testid="update-banner"]')).toBeNull()
    } finally {
      await unmount(element, root)
    }
  })
})
