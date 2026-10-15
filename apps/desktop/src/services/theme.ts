// Pure theme-mode logic: values, localStorage (de)serialization, and applying
// the mode to the document root. No rabjs or React dependencies so it stays
// unit-testable and safe to run at module scope in main.tsx (pre-paint).

export type ThemeMode = 'light' | 'dark' | 'system'

export const THEME_STORAGE_KEY = 'stride:theme'

export const THEME_MODES: readonly ThemeMode[] = ['light', 'dark', 'system']

export const DEFAULT_THEME: ThemeMode = 'system'

export function sanitizeTheme(value: unknown): ThemeMode {
  return typeof value === 'string' && (THEME_MODES as readonly string[]).includes(value)
    ? (value as ThemeMode)
    : DEFAULT_THEME
}

/** Minimal storage contract so tests can pass a fake; localStorage satisfies it. */
export interface ThemeStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export function defaultThemeStorage(): ThemeStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

export function readStoredTheme(storage: ThemeStorage | null): ThemeMode {
  if (!storage) return DEFAULT_THEME
  try {
    return sanitizeTheme(storage.getItem(THEME_STORAGE_KEY))
  } catch {
    return DEFAULT_THEME
  }
}

export function writeStoredTheme(storage: ThemeStorage | null, mode: ThemeMode): void {
  if (!storage) return
  try {
    storage.setItem(THEME_STORAGE_KEY, sanitizeTheme(mode))
  } catch {
    // Quota or privacy-mode failures must never break theme switching.
  }
}

/**
 * Apply the mode to the root element. light/dark set an explicit data-theme
 * override; system removes the attribute so the prefers-color-scheme media
 * query in tokens.css drives the palette and follows OS changes live (no JS
 * listener needed — CSS does the tracking).
 */
export function applyTheme(mode: ThemeMode, root?: HTMLElement | null): void {
  const target = root ?? (typeof document === 'undefined' ? null : document.documentElement)
  if (!target) return
  const next = sanitizeTheme(mode)
  if (next === 'system') target.removeAttribute('data-theme')
  else target.setAttribute('data-theme', next)
}

/**
 * Synchronously re-apply the persisted mode. main.tsx calls this at module
 * scope so the attribute is set before the first paint (no theme flash).
 */
export function applyStoredTheme(storage: ThemeStorage | null = defaultThemeStorage()): ThemeMode {
  const mode = readStoredTheme(storage)
  applyTheme(mode)
  return mode
}
