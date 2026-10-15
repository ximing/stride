import { has, register, Service } from '@rabjs/react'
import {
  applyStoredTheme,
  applyTheme,
  DEFAULT_THEME,
  defaultThemeStorage,
  readStoredTheme,
  sanitizeTheme,
  writeStoredTheme,
  type ThemeMode,
} from './theme'

export class ThemeService extends Service {
  mode: ThemeMode = DEFAULT_THEME

  constructor() {
    super()
    this.mode = readStoredTheme(defaultThemeStorage())
  }

  /** What is actually on screen, resolving 'system' through matchMedia. */
  get resolved(): 'light' | 'dark' {
    if (this.mode !== 'system') return this.mode
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
    }
    return 'light'
  }

  setTheme(mode: ThemeMode) {
    this.mode = sanitizeTheme(mode)
    writeStoredTheme(defaultThemeStorage(), this.mode)
    applyTheme(this.mode)
  }

  /** Re-read storage and re-apply to the document root (idempotent). */
  apply() {
    this.mode = applyStoredTheme()
  }
}

// Tests mount the workspace without main.tsx, so the global service must exist on import.
if (!has(ThemeService)) register(ThemeService)
