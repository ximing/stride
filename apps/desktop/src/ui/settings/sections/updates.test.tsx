import { has, register, resolve } from '@rabjs/react'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
import { MemorySecretsStore } from '@stride/platform'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetSecretsStore, setSecretsStore, SETTINGS_STORAGE_KEY, SettingsService } from '../../../services/panels.service'
import { UpdatesSection } from './updates'

function defaultForm() {
  return {
    embedding: { endpoint: '', model: '', keyMask: '', dim: 4 },
    llmConfigs: [],
    releasesUrl: '',
    gitEnabled: true,
    autoSyncMinutes: 0,
    autoGitEnabled: false,
    autoGitIdleSeconds: 0,
    autoGitBlurSeconds: 0,
    appearance: { noteWidth: 'standard' as const, fontSize: 15 },
    editor: { autosaveDebounceMs: 350 },
    updates: { channel: 'stable' as const, autoCheck: true },
    privacy: { telemetryEnabled: false },
  }
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

function storedSettings(): Record<string, any> | null {
  const raw = localStorage.getItem(SETTINGS_STORAGE_KEY)
  return raw ? JSON.parse(raw) : null
}

describe('updates settings section', () => {
  let host: HTMLDivElement | null = null
  let root: Root | null = null

  beforeEach(() => {
    if (!has(SettingsService)) register(SettingsService)
    setSecretsStore(new MemorySecretsStore())
    const settings = resolve(SettingsService)
    settings.form = defaultForm()
    settings.notice = ''
  })

  afterEach(async () => {
    if (root) await act(async () => root?.unmount())
    host?.remove()
    root = null
    host = null
    localStorage.removeItem(SETTINGS_STORAGE_KEY)
    resetSecretsStore()
    const settings = resolve(SettingsService)
    settings.form = defaultForm()
    settings.notice = ''
  })

  async function mount() {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => {
      root?.render(<UpdatesSection />)
    })
  }

  function field(testId: string): HTMLInputElement {
    return document.querySelector(`[data-testid="${testId}"]`) as HTMLInputElement
  }

  async function clickSave() {
    const button = document.querySelector('[data-testid="settings-updates-save"]') as HTMLButtonElement
    await act(async () => {
      button.click()
      // Wait until the async save() settles (status line or service notice).
      for (let i = 0; i < 100; i++) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 10))
        if (document.querySelector('[data-testid="settings-updates-status"]') || resolve(SettingsService).notice) return
      }
    })
  }

  it('shows the stored values from the existing settings form', async () => {
    const settings = resolve(SettingsService)
    settings.form = {
      ...settings.form,
      releasesUrl: 'https://example.com/releases',
      updates: { channel: 'beta', autoCheck: false },
    }
    await mount()
    expect(field('settings-updates-channel-beta').checked).toBe(true)
    expect(field('settings-updates-channel-stable').checked).toBe(false)
    expect(field('settings-updates-auto-check').checked).toBe(false)
    expect(field('settings-updates-releases-url').value).toBe('https://example.com/releases')
  })

  it('explains how each channel reaches the updater', async () => {
    await mount()
    const note = document.querySelector('[data-testid="settings-updates-note"]')?.textContent ?? ''
    expect(note).toContain('beta-latest')
    expect(note).toContain('next update check')
  })

  it('rejects a malformed releases URL and blocks saving', async () => {
    await mount()
    await act(async () => {
      setInputValue(field('settings-updates-releases-url'), 'not a url')
    })
    await clickSave()
    expect(document.querySelector('[data-testid="settings-updates-releases-url-error"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="settings-updates-status"]')?.textContent).toContain('Fix')
    expect(storedSettings()).toBeNull()
    expect(resolve(SettingsService).form.releasesUrl).toBe('')
  })

  it('accepts an empty releases URL as the default', async () => {
    const settings = resolve(SettingsService)
    settings.form = { ...settings.form, releasesUrl: 'https://example.com/releases' }
    await mount()
    await act(async () => {
      setInputValue(field('settings-updates-releases-url'), '   ')
    })
    await clickSave()
    expect(document.querySelector('[data-testid="settings-updates-releases-url-error"]')).toBeNull()
    expect(storedSettings()?.releasesUrl).toBe('')
  })

  it('saves channel, auto check, and releases URL through SettingsService', async () => {
    await mount()
    await act(async () => {
      field('settings-updates-channel-beta').click()
      field('settings-updates-auto-check').click()
      setInputValue(field('settings-updates-releases-url'), 'https://example.com/releases')
    })
    await clickSave()
    expect(document.querySelector('[data-testid="settings-updates-status"]')?.textContent).toBe('Saved.')
    const stored = storedSettings()
    expect(stored).not.toBeNull()
    expect(stored!.updates).toEqual({ channel: 'beta', autoCheck: false })
    expect(stored!.releasesUrl).toBe('https://example.com/releases')
    const settings = resolve(SettingsService)
    expect(settings.form.updates).toEqual({ channel: 'beta', autoCheck: false })
    expect(settings.form.releasesUrl).toBe('https://example.com/releases')
    expect(settings.notice).toBe('')
  })
})
