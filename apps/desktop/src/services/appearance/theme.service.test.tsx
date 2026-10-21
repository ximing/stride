import { resolve } from '@rabjs/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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

// The settings-UI theme control is covered by the Appearance section test in
// ui/settings/sections/t72-sections.test.tsx (the old settings-panel.tsx it
// replaced was deleted in T7.3).
