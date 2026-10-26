import { afterEach, describe, expect, it } from 'vitest'
import {
  applyFavicon,
  applyStoredTheme,
  applyTheme,
  DEFAULT_THEME,
  FAVICON,
  readStoredTheme,
  resolvedTheme,
  sanitizeTheme,
  THEME_STORAGE_KEY,
  writeStoredTheme,
  type ThemeStorage,
} from './theme'

function fakeStorage(initial: Record<string, string> = {}): ThemeStorage & { data: Record<string, string> } {
  return {
    data: { ...initial },
    getItem(key) {
      return key in this.data ? this.data[key] : null
    },
    setItem(key, value) {
      this.data[key] = value
    },
  }
}

afterEach(() => {
  document.documentElement.removeAttribute('data-theme')
})

describe('sanitizeTheme', () => {
  it('passes through valid modes', () => {
    expect(sanitizeTheme('light')).toBe('light')
    expect(sanitizeTheme('dark')).toBe('dark')
    expect(sanitizeTheme('system')).toBe('system')
  })

  it('falls back to system for garbage', () => {
    expect(sanitizeTheme('blue')).toBe(DEFAULT_THEME)
    expect(sanitizeTheme('')).toBe(DEFAULT_THEME)
    expect(sanitizeTheme(null)).toBe(DEFAULT_THEME)
    expect(sanitizeTheme(undefined)).toBe(DEFAULT_THEME)
    expect(sanitizeTheme(42)).toBe(DEFAULT_THEME)
    expect(sanitizeTheme({ mode: 'dark' })).toBe(DEFAULT_THEME)
    expect(sanitizeTheme('"dark"')).toBe(DEFAULT_THEME)
  })
})

describe('readStoredTheme / writeStoredTheme', () => {
  it('returns the default when storage is missing or empty', () => {
    expect(readStoredTheme(null)).toBe(DEFAULT_THEME)
    expect(readStoredTheme(fakeStorage())).toBe(DEFAULT_THEME)
  })

  it('round-trips a stored mode', () => {
    const storage = fakeStorage()
    writeStoredTheme(storage, 'dark')
    expect(storage.data[THEME_STORAGE_KEY]).toBe('dark')
    expect(readStoredTheme(storage)).toBe('dark')
  })

  it('sanitizes on write and on read', () => {
    const storage = fakeStorage({ [THEME_STORAGE_KEY]: 'neon' })
    expect(readStoredTheme(storage)).toBe(DEFAULT_THEME)
    writeStoredTheme(storage, 'neon' as never)
    expect(storage.data[THEME_STORAGE_KEY]).toBe(DEFAULT_THEME)
  })

  it('never throws on broken storage', () => {
    const broken: ThemeStorage = {
      getItem() {
        throw new Error('denied')
      },
      setItem() {
        throw new Error('quota')
      },
    }
    expect(readStoredTheme(broken)).toBe(DEFAULT_THEME)
    expect(() => writeStoredTheme(broken, 'dark')).not.toThrow()
    expect(() => writeStoredTheme(null, 'dark')).not.toThrow()
  })
})

describe('applyTheme', () => {
  it('sets an explicit data-theme attribute for light and dark', () => {
    applyTheme('light')
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
    applyTheme('dark')
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
  })

  it('removes the attribute for system so the media query drives the palette', () => {
    applyTheme('dark')
    applyTheme('system')
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false)
  })

  it('sanitizes garbage input to system', () => {
    applyTheme('dark')
    applyTheme('neon' as never)
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false)
  })

  it('accepts an explicit root element', () => {
    const root = document.createElement('div')
    applyTheme('dark', root)
    expect(root.getAttribute('data-theme')).toBe('dark')
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false)
  })
})

describe('resolvedTheme / applyFavicon', () => {
  afterEach(() => {
    document.getElementById('stride-favicon')?.remove()
  })

  it('keeps an explicit mode and lets system follow the OS flag', () => {
    expect(resolvedTheme('light', true)).toBe('light')
    expect(resolvedTheme('dark', false)).toBe('dark')
    expect(resolvedTheme('system', true)).toBe('dark')
    expect(resolvedTheme('system', false)).toBe('light')
    expect(resolvedTheme('neon' as never, true)).toBe('dark')
  })

  it('swaps the tab icon and drops the media-query links', () => {
    const light = document.createElement('link')
    light.rel = 'icon'
    light.href = '/favicon-light.png'
    light.media = '(prefers-color-scheme: light)'
    document.head.appendChild(light)
    applyFavicon('dark')
    expect(document.querySelectorAll('link[rel="icon"]')).toHaveLength(1)
    const icon = document.getElementById('stride-favicon')
    expect(icon?.getAttribute('href')).toBe(FAVICON.dark)
    applyFavicon('system', false)
    expect(icon?.getAttribute('href')).toBe(FAVICON.light)
  })
})

describe('applyStoredTheme', () => {
  it('reads storage and applies it to the document root', () => {
    const storage = fakeStorage({ [THEME_STORAGE_KEY]: 'dark' })
    const mode = applyStoredTheme(storage)
    expect(mode).toBe('dark')
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
  })

  it('clears the attribute when the stored mode is system', () => {
    document.documentElement.setAttribute('data-theme', 'dark')
    const mode = applyStoredTheme(fakeStorage({ [THEME_STORAGE_KEY]: 'system' }))
    expect(mode).toBe('system')
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false)
  })
})
