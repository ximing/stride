import { afterEach, describe, expect, it } from 'vitest'
import {
  applyLocale,
  applyStoredLocale,
  DEFAULT_LOCALE,
  LOCALE_STORAGE_KEY,
  localeLang,
  readStoredLocale,
  sanitizeLocale,
  writeStoredLocale,
  type LocaleStorage,
} from './locale'

function fakeStorage(initial: Record<string, string> = {}): LocaleStorage & { data: Record<string, string> } {
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
  document.documentElement.lang = 'en'
})

describe('sanitizeLocale', () => {
  it('keeps en and zh and falls back to English', () => {
    expect(sanitizeLocale('en')).toBe('en')
    expect(sanitizeLocale('zh')).toBe('zh')
    expect(sanitizeLocale('zh-CN')).toBe(DEFAULT_LOCALE)
    expect(sanitizeLocale('fr')).toBe(DEFAULT_LOCALE)
    expect(sanitizeLocale('')).toBe(DEFAULT_LOCALE)
    expect(sanitizeLocale(null)).toBe(DEFAULT_LOCALE)
  })
})

describe('locale storage', () => {
  it('defaults to English when nothing is stored', () => {
    const storage = fakeStorage()
    expect(readStoredLocale(storage)).toBe('en')
    expect(readStoredLocale(null)).toBe('en')
  })

  it('round-trips a valid locale and ignores garbage', () => {
    const storage = fakeStorage()
    writeStoredLocale(storage, 'zh')
    expect(storage.data[LOCALE_STORAGE_KEY]).toBe('zh')
    expect(readStoredLocale(storage)).toBe('zh')
    storage.data[LOCALE_STORAGE_KEY] = 'neon'
    expect(readStoredLocale(storage)).toBe('en')
  })

  it('writes only the locale key', () => {
    const storage = fakeStorage({ 'stride:settings': '{}', 'stride:theme': 'dark' })
    writeStoredLocale(storage, 'zh')
    expect(storage.data).toEqual({
      'stride:settings': '{}',
      'stride:theme': 'dark',
      [LOCALE_STORAGE_KEY]: 'zh',
    })
  })
})

describe('applyLocale', () => {
  it('sets the document language and restores a stored choice', () => {
    const root = document.createElement('html')
    expect(applyLocale('zh', root)).toBe('zh')
    expect(root.lang).toBe(localeLang('zh'))
    expect(localeLang('en')).toBe('en')
    const storage = fakeStorage({ [LOCALE_STORAGE_KEY]: 'zh' })
    expect(applyStoredLocale(storage)).toBe('zh')
    expect(document.documentElement.lang).toBe('zh-CN')
  })
})
