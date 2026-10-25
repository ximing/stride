import { has, register, resolve } from '@rabjs/react'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
import { MemoryFileSystem, MemorySecretsStore, type GitBackend } from '@stride/platform'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GitService, setGitBackendForTests } from '../../../services/git/git.service'
import { resetSecretsStore, setSecretsStore, SETTINGS_STORAGE_KEY, SettingsService } from '../../../services/settings/settings.service'
import { VaultService } from '../../../services/vault/vault.service'
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
    appearance: { noteWidth: 'standard' as const, fontSize: 15, fontFamily: '' },
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

  it('rejects a repository URL that is not a git remote and does not save', async () => {
    register(VaultService)
    register(GitService)
    const vault = resolve(VaultService)
    vault.fs = new MemoryFileSystem('/tmp/settings-git-url')
    vault.phase = 'ready'
    await mount()
    await act(async () => {
      setInputValue(field('settings-git-remote'), 'not a url')
    })
    await clickSave()
    expect(document.body.textContent).toContain('http(s)')
    expect(storedSettings()).toBeNull()
    vault.phase = 'chooser'
    vault.fs = null
  })

  it('writes the repository URL when git settings are saved', async () => {
    const calls: string[] = []
    const backend: GitBackend = {
      available: true,
      init: () => Promise.resolve(),
      status: () => Promise.resolve({ repo: true, porcelain: '', clean: true }),
      diff: () => Promise.resolve(''),
      commit: () => Promise.resolve(''),
      history: () => Promise.resolve([]),
      show: () => Promise.resolve(''),
      currentBranch: () => Promise.resolve('main'),
      aheadBehind: () => Promise.resolve({ ahead: 0, behind: 0 }),
      remoteUrl: () => Promise.resolve(null),
      addRemote: (_repo, url) => {
        calls.push(url)
        return Promise.resolve()
      },
      fetch: () => Promise.resolve(),
      sharesHistory: () => Promise.resolve(true),
      removeRemote: () => Promise.resolve(),
      push: () => Promise.resolve(''),
      pull: () => Promise.resolve({ conflict: false, files: [], output: '' }),
      unmerged: () => Promise.resolve([]),
      resolve: () => Promise.resolve(),
      clone: () => Promise.resolve(),
    }
    setGitBackendForTests(backend)
    register(VaultService)
    register(GitService)
    const files = new MemoryFileSystem('/tmp/settings-git-save')
    await files.mkdir('.git')
    const vault = resolve(VaultService)
    vault.fs = files
    vault.phase = 'ready'
    vault.broad = false
    resolve(SettingsService).setGitEnabled(true)
    const git = resolve(GitService)
    await git.refresh()
    await mount()
    await act(async () => {
      setInputValue(field('settings-git-remote'), 'https://example.test/notes.git')
    })
    await clickSave()
    expect(document.querySelector('[data-testid="settings-git-status"]')?.textContent).toBe('Saved.')
    expect(calls).toEqual(['https://example.test/notes.git'])
    expect(git.output).toBe('')
    vault.phase = 'chooser'
    vault.fs = null
    setGitBackendForTests(null)
  })
})
