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

/** Tab icons. The in-app mark uses the same pair, switched from CSS. */
export const FAVICON = {
  light: '/favicon-light.png',
  dark: '/favicon-dark.png',
} as const

export function prefersDark(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches
  } catch {
    return false
  }
}

/** light/dark stay explicit. system follows the OS, defaulting to light. */
export function resolvedTheme(mode: ThemeMode, dark = prefersDark()): 'light' | 'dark' {
  const next = sanitizeTheme(mode)
  if (next === 'light' || next === 'dark') return next
  return dark ? 'dark' : 'light'
}

/**
 * Point the tab icon at the resolved theme. Replaces the media-query links in
 * index.html so an explicit light/dark choice wins over the OS scheme.
 * System mode still has to be applied from JS: the favicon document cannot
 * see the app's data-theme attribute.
 */
export function applyFavicon(mode: ThemeMode, dark?: boolean): void {
  if (typeof document === 'undefined') return
  const href = FAVICON[resolvedTheme(mode, dark ?? prefersDark())]
  document.querySelectorAll('link[rel="icon"]').forEach((node) => {
    if (node.id !== 'stride-favicon') node.remove()
  })
  let link = document.getElementById('stride-favicon')
  if (!(link instanceof HTMLLinkElement)) {
    link = document.createElement('link')
    link.id = 'stride-favicon'
    link.rel = 'icon'
    link.type = 'image/png'
    document.head.appendChild(link)
  }
  if (link.getAttribute('href') !== href) link.setAttribute('href', href)
}

/**
 * Synchronously re-apply the persisted mode. main.tsx calls this at module
 * scope so the attribute is set before the first paint (no theme flash).
 */
export function applyStoredTheme(storage: ThemeStorage | null = defaultThemeStorage()): ThemeMode {
  const mode = readStoredTheme(storage)
  applyTheme(mode)
  applyFavicon(mode)
  return mode
}
