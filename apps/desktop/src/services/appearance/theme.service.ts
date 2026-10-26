import { has, register, Service } from '@rabjs/react'
import { applyStoredAppearance } from './appearance'
import {
  applyFavicon,
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
    this.watchSystemTheme()
  }

  /** The palette follows the OS in CSS. The favicon is a document link, so it needs this. */
  private watchSystemTheme() {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    let media: MediaQueryList
    try {
      media = window.matchMedia('(prefers-color-scheme: dark)')
    } catch {
      return
    }
    if (typeof media.addEventListener !== 'function') return
    media.addEventListener('change', () => {
      if (this.mode === 'system') applyFavicon('system')
    })
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
    applyFavicon(this.mode)
  }

  /** Re-read storage and re-apply to the document root (idempotent). */
  apply() {
    this.mode = applyStoredTheme()
  }
}

// Tests mount the workspace without main.tsx, so the global service must exist on import.
if (!has(ThemeService)) register(ThemeService)

// Note width / font size follow the same pre-paint pattern as applyStoredTheme()
// in main.tsx: this module is imported there at module scope, so the stored
// appearance lands on <html> before the first render and never flashes defaults.
applyStoredAppearance()
