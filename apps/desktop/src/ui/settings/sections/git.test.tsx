import { has, register, resolve } from '@rabjs/react'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
import { MemorySecretsStore } from '@stride/platform'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetSecretsStore, setSecretsStore, SETTINGS_STORAGE_KEY, SettingsService } from '../../../services/settings/settings.service'
import { GitSection } from './git'

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

describe('git settings section', () => {
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
      root?.render(<GitSection />)
    })
  }

  function field(testId: string): HTMLInputElement {
    return document.querySelector(`[data-testid="${testId}"]`) as HTMLInputElement
  }

  async function clickSave() {
    const button = document.querySelector('[data-testid="settings-git-save"]') as HTMLButtonElement
    await act(async () => {
      button.click()
      // Wait until the async save() settles (status line or service notice).
      for (let i = 0; i < 100; i++) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 10))
        if (document.querySelector('[data-testid="settings-git-status"]') || resolve(SettingsService).notice) return
      }
    })
  }

  it('shows the stored values from the existing settings form', async () => {
    const settings = resolve(SettingsService)
    settings.form = {
      ...settings.form,
      gitEnabled: false,
      autoSyncMinutes: 15,
      autoGitEnabled: true,
      autoGitIdleSeconds: 45,
      autoGitBlurSeconds: 10,
    }
    await mount()
    expect(field('settings-git-enabled').checked).toBe(false)
    expect(field('settings-git-auto-pull').value).toBe('15')
    expect(field('settings-git-autogit-enabled').checked).toBe(true)
    expect(field('settings-git-autogit-idle').value).toBe('45')
    expect(field('settings-git-autogit-blur').value).toBe('10')
  })

  it('rejects non-numeric and out-of-range input and blocks saving', async () => {
    await mount()
    await act(async () => {
      setInputValue(field('settings-git-auto-pull'), 'abc')
      setInputValue(field('settings-git-autogit-idle'), '3601')
      setInputValue(field('settings-git-autogit-blur'), '-5')
    })
    await clickSave()
    expect(document.querySelector('[data-testid="settings-git-auto-pull-error"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="settings-git-autogit-idle-error"]')?.textContent).toContain('0 and 3600')
    expect(document.querySelector('[data-testid="settings-git-autogit-blur-error"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="settings-git-status"]')?.textContent).toContain('Fix')
    expect(storedSettings()).toBeNull()
    expect(resolve(SettingsService).form.autoSyncMinutes).toBe(0)
  })

  it('clears a field error once the draft parses again', async () => {
    await mount()
    await act(async () => {
      setInputValue(field('settings-git-auto-pull'), '1441')
    })
    await clickSave()
    expect(document.querySelector('[data-testid="settings-git-auto-pull-error"]')).not.toBeNull()
    await act(async () => {
      setInputValue(field('settings-git-auto-pull'), '1440')
    })
    expect(document.querySelector('[data-testid="settings-git-auto-pull-error"]')).toBeNull()
  })

  it('saves drafts through SettingsService and round-trips localStorage', async () => {
    await mount()
    await act(async () => {
      field('settings-git-enabled').click()
      setInputValue(field('settings-git-auto-pull'), '30')
      field('settings-git-autogit-enabled').click()
      setInputValue(field('settings-git-autogit-idle'), '45')
      setInputValue(field('settings-git-autogit-blur'), '10')
    })
    await clickSave()
    expect(document.querySelector('[data-testid="settings-git-status"]')?.textContent).toBe('Saved.')
    const stored = storedSettings()
    expect(stored).not.toBeNull()
    expect(stored!.gitEnabled).toBe(false)
    expect(stored!.autoSyncMinutes).toBe(30)
    expect(stored!.autoGitEnabled).toBe(true)
    expect(stored!.autoGitIdleSeconds).toBe(45)
    expect(stored!.autoGitBlurSeconds).toBe(10)
    const settings = resolve(SettingsService)
    expect(settings.form.gitEnabled).toBe(false)
    expect(settings.form.autoSyncMinutes).toBe(30)
    expect(settings.notice).toBe('')
  })
})
