// T7.2: Appearance / Editor / Privacy settings sections.

globalThis.IS_REACT_ACT_ENVIRONMENT = true

import { has, register, resolve } from '@rabjs/react'
import { MemorySecretsStore } from '@stride/platform'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readNoteFile } from '../../../../../../packages/core/src/vault'
import { APPEARANCE_STORAGE_KEY } from '../../../services/appearance/appearance'
import { FolderService } from '../../../services/vault/folder.service'
import { GitService } from '../../../services/git/git.service'
import { resetSecretsStore, setSecretsStore, SETTINGS_STORAGE_KEY, SettingsService } from '../../../services/settings/settings.service'
import { THEME_STORAGE_KEY } from '../../../services/appearance/theme'
import { ThemeService } from '../../../services/appearance/theme.service'
import { VaultService } from '../../../services/vault/vault.service'
import { AppearanceSection } from './appearance'
import { EditorSection } from './editor'
import { PrivacySection } from './privacy'

function useMemoryFixture() {
  window.history.replaceState(null, '', '/?fixture=memory')
}

function setControlValue(element: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setter?.call(element, value)
  element.dispatchEvent(new Event('input', { bubbles: true }))
  element.dispatchEvent(new Event('change', { bubbles: true }))
}

function resetSettingsForm() {
  const settings = resolve(SettingsService)
  settings.form = {
    ...settings.form,
    appearance: { noteWidth: 'standard', fontSize: 15 },
    editor: { autosaveDebounceMs: 350 },
    privacy: { telemetryEnabled: false },
  }
  settings.notice = ''
}

describe('T7.2 settings sections', () => {
  let host: HTMLDivElement | null = null
  let root: Root | null = null

  beforeEach(() => {
    register(VaultService)
    register(FolderService)
    register(GitService)
    register(SettingsService)
    setSecretsStore(new MemorySecretsStore())
    resetSettingsForm()
  })

  afterEach(() => {
    act(() => {
      root?.unmount()
    })
    host?.remove()
    root = null
    host = null
    window.history.replaceState(null, '', '/')
    vi.useRealTimers()
    vi.unstubAllGlobals()
    resetSecretsStore()
    localStorage.removeItem(THEME_STORAGE_KEY)
    localStorage.removeItem(APPEARANCE_STORAGE_KEY)
    localStorage.removeItem(SETTINGS_STORAGE_KEY)
    document.documentElement.removeAttribute('data-theme')
    document.documentElement.style.removeProperty('--sd-note-max-width')
    document.documentElement.style.removeProperty('--sd-note-font-size')
    resolve(ThemeService).setTheme('system')
    if (has(VaultService)) resolve(VaultService).cancelPending()
  })

  async function mount(component: ReactElement) {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => {
      root?.render(component)
    })
    return host
  }

  it('appearance: switches the theme with immediate data-theme + persistence', async () => {
    const mounted = await mount(<AppearanceSection />)
    expect(mounted.querySelector('[data-testid="settings-section-appearance"]')).not.toBeNull()
    const dark = mounted.querySelector<HTMLButtonElement>('[data-testid="theme-dark"]')!
    await act(async () => {
      dark.click()
    })
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark')
    expect(dark.getAttribute('aria-pressed')).toBe('true')
  })

  it('appearance: note width applies the CSS variable instantly and persists', async () => {
    const mounted = await mount(<AppearanceSection />)
    const wide = mounted.querySelector<HTMLButtonElement>('[data-testid="note-width-wide"]')!
    await act(async () => {
      wide.click()
    })
    expect(document.documentElement.style.getPropertyValue('--sd-note-max-width')).toBe('none')
    expect(wide.getAttribute('aria-pressed')).toBe('true')
    expect(resolve(SettingsService).form.appearance.noteWidth).toBe('wide')
    expect(localStorage.getItem(APPEARANCE_STORAGE_KEY)).toContain('"wide"')
    // Persisted through SettingsService.save into the settings snapshot too.
    expect(localStorage.getItem(SETTINGS_STORAGE_KEY) ?? '').toContain('"noteWidth": "wide"')
  })

  it('appearance: font size applies when valid and rejects out-of-range input in place', async () => {
    const mounted = await mount(<AppearanceSection />)
    const input = mounted.querySelector<HTMLInputElement>('[data-testid="note-font-size"]')!
    await act(async () => {
      setControlValue(input, '18')
    })
    expect(document.documentElement.style.getPropertyValue('--sd-note-font-size')).toBe('18px')
    expect(resolve(SettingsService).form.appearance.fontSize).toBe(18)
    expect(mounted.querySelector('[data-testid="note-font-size-error"]')).toBeNull()

    await act(async () => {
      setControlValue(input, '25')
    })
    expect(mounted.querySelector('[data-testid="note-font-size-error"]')).not.toBeNull()
    // Invalid input never touches applied or persisted state.
    expect(document.documentElement.style.getPropertyValue('--sd-note-font-size')).toBe('18px')
    expect(resolve(SettingsService).form.appearance.fontSize).toBe(18)
  })

  it('editor: debounce validates in place and pushes valid values into VaultService', async () => {
    const mounted = await mount(<EditorSection />)
    const input = mounted.querySelector<HTMLInputElement>('[data-testid="autosave-debounce"]')!
    expect(input.value).toBe('350')

    await act(async () => {
      setControlValue(input, '50')
    })
    expect(mounted.querySelector('[data-testid="autosave-debounce-error"]')).not.toBeNull()
    expect(resolve(SettingsService).form.editor.autosaveDebounceMs).toBe(350)

    await act(async () => {
      setControlValue(input, '800')
    })
    expect(mounted.querySelector('[data-testid="autosave-debounce-error"]')).toBeNull()
    expect(resolve(SettingsService).form.editor.autosaveDebounceMs).toBe(800)
    expect(localStorage.getItem(SETTINGS_STORAGE_KEY) ?? '').toContain('"autosaveDebounceMs": 800')
  })

  it('editor: autosave timer honors the configured debounce', async () => {
    useMemoryFixture()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const vault = resolve(VaultService)
    await vault.restoreOpened()
    await vault.openFromDraft()
    const mounted = await mount(<EditorSection />)
    const input = mounted.querySelector<HTMLInputElement>('[data-testid="autosave-debounce"]')!
    await act(async () => {
      setControlValue(input, '800')
    })

    await vault.createNote()
    const id = vault.active?.id ?? ''
    vault.updateDoc({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'debounceword' }] }],
    })
    await vi.advanceTimersByTimeAsync(350)
    expect(vault.saveStatus).toBe('pending')
    await vi.advanceTimersByTimeAsync(450)
    expect(vault.saveStatus).toBe('saved')
    const saved = await readNoteFile(vault.fs!, `${id}.stride.json`, id)
    expect(JSON.stringify(saved.doc)).toContain('debounceword')
    vault.cancelPending()
  })

  it('editor: rename-from-heading is disabled without a vault and writes .stride/vault.json when open', async () => {
    const mounted = await mount(<EditorSection />)
    const disabledToggle = mounted.querySelector<HTMLInputElement>('[data-testid="settings-rename-from-heading"]')!
    expect(disabledToggle.disabled).toBe(true)

    useMemoryFixture()
    const vault = resolve(VaultService)
    await vault.restoreOpened()
    await act(async () => {
      await vault.openFromDraft()
    })
    expect(vault.phase).toBe('ready')
    const toggle = mounted.querySelector<HTMLInputElement>('[data-testid="settings-rename-from-heading"]')!
    expect(toggle.disabled).toBe(false)
    expect(toggle.checked).toBe(true)

    await act(async () => {
      toggle.click()
    })
    expect(vault.renameFromHeading).toBe(false)
    const marker = await vault.fs!.readText('.stride/vault.json')
    expect(marker).toContain('"renameFromHeading": false')
    vault.cancelPending()
  })

  it('privacy: telemetry toggle persists the preference only', async () => {
    const mounted = await mount(<PrivacySection />)
    expect(mounted.textContent).toContain('does not collect any telemetry')
    const toggle = mounted.querySelector<HTMLInputElement>('[data-testid="telemetry-enabled"]')!
    expect(toggle.checked).toBe(false)
    await act(async () => {
      toggle.click()
    })
    expect(resolve(SettingsService).form.privacy.telemetryEnabled).toBe(true)
    expect(localStorage.getItem(SETTINGS_STORAGE_KEY) ?? '').toContain('"telemetryEnabled": true')
  })
})
