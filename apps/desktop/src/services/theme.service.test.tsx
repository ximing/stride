import { has, register, resolve } from '@rabjs/react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SettingsPanel } from '../ui/settings-panel'
import { SettingsService, UpdateService } from './panels.service'
import { THEME_STORAGE_KEY } from './theme'
import { ThemeService } from './theme.service'

describe('ThemeService', () => {
  beforeEach(() => {
    localStorage.removeItem(THEME_STORAGE_KEY)
    document.documentElement.removeAttribute('data-theme')
    resolve(ThemeService).setTheme('system')
  })

  afterEach(() => {
    localStorage.removeItem(THEME_STORAGE_KEY)
    document.documentElement.removeAttribute('data-theme')
  })

  it('defaults to system', () => {
    expect(resolve(ThemeService).mode).toBe('system')
  })

  it('setTheme persists to localStorage and applies data-theme immediately', () => {
    const theme = resolve(ThemeService)
    theme.setTheme('dark')
    expect(theme.mode).toBe('dark')
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark')
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
  })

  it('system removes the data-theme override', () => {
    const theme = resolve(ThemeService)
    theme.setTheme('light')
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
    theme.setTheme('system')
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false)
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('system')
  })

  it('apply() re-reads storage and re-applies (restart memory)', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'dark')
    const theme = resolve(ThemeService)
    theme.apply()
    expect(theme.mode).toBe('dark')
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
  })

  it('ignores garbage in storage', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'neon')
    const theme = resolve(ThemeService)
    theme.apply()
    expect(theme.mode).toBe('system')
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false)
  })
})

describe('settings panel theme control', () => {
  let root: ReturnType<typeof createRoot> | undefined
  let host: HTMLDivElement | undefined

  beforeEach(() => {
    localStorage.removeItem(THEME_STORAGE_KEY)
    document.documentElement.removeAttribute('data-theme')
    resolve(ThemeService).setTheme('system')
    if (!has(SettingsService)) register(SettingsService)
    if (!has(UpdateService)) register(UpdateService)
  })

  afterEach(() => {
    act(() => {
      root?.unmount()
    })
    host?.remove()
    root = undefined
    host = undefined
    localStorage.removeItem(THEME_STORAGE_KEY)
    document.documentElement.removeAttribute('data-theme')
  })

  it('switches the theme from the settings panel, applying data-theme on <html>', async () => {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => {
      root?.render(<SettingsPanel />)
    })

    const systemButton = host.querySelector<HTMLButtonElement>('[data-testid="theme-system"]')
    const lightButton = host.querySelector<HTMLButtonElement>('[data-testid="theme-light"]')
    const darkButton = host.querySelector<HTMLButtonElement>('[data-testid="theme-dark"]')
    expect(systemButton).not.toBeNull()
    expect(systemButton?.getAttribute('aria-pressed')).toBe('true')
    expect(lightButton?.getAttribute('aria-pressed')).toBe('false')

    await act(async () => {
      darkButton?.click()
    })
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    expect(darkButton?.getAttribute('aria-pressed')).toBe('true')
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark')

    await act(async () => {
      lightButton?.click()
    })
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
    expect(lightButton?.getAttribute('aria-pressed')).toBe('true')
    expect(darkButton?.getAttribute('aria-pressed')).toBe('false')

    await act(async () => {
      systemButton?.click()
    })
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false)
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('system')
  })
})
