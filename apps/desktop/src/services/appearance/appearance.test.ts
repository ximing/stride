import { afterEach, describe, expect, it } from 'vitest'
import {
  APPEARANCE_STORAGE_KEY,
  applyAppearance,
  applyStoredAppearance,
  DEFAULT_APPEARANCE,
  isValidNoteFontSize,
  NOTE_WIDTH_CSS,
  readStoredAppearance,
  sanitizeAppearance,
  writeStoredAppearance,
  type AppearanceStorage,
} from './appearance'

function memoryStorage(initial: Record<string, string> = {}): AppearanceStorage & { data: Record<string, string> } {
  const data = { ...initial }
  return {
    data,
    getItem: (key) => (key in data ? data[key]! : null),
    setItem: (key, value) => {
      data[key] = value
    },
  }
}

describe('appearance prefs', () => {
  afterEach(() => {
    document.documentElement.style.removeProperty('--sd-note-max-width')
    document.documentElement.style.removeProperty('--sd-note-font-size')
  })

  it('sanitizes garbage to defaults', () => {
    expect(sanitizeAppearance(null)).toEqual(DEFAULT_APPEARANCE)
    expect(sanitizeAppearance('wide')).toEqual(DEFAULT_APPEARANCE)
    expect(sanitizeAppearance({ noteWidth: 'huge', fontSize: -3 })).toEqual(DEFAULT_APPEARANCE)
    expect(sanitizeAppearance({ noteWidth: 'narrow', fontSize: 18 })).toEqual({ noteWidth: 'narrow', fontSize: 18 })
  })

  it('validates the font size range as whole numbers 12-20', () => {
    expect(isValidNoteFontSize(12)).toBe(true)
    expect(isValidNoteFontSize(20)).toBe(true)
    expect(isValidNoteFontSize(11)).toBe(false)
    expect(isValidNoteFontSize(21)).toBe(false)
    expect(isValidNoteFontSize(15.5)).toBe(false)
    expect(isValidNoteFontSize(Number.NaN)).toBe(false)
  })

  it('round-trips through storage and ignores corrupt JSON', () => {
    const storage = memoryStorage()
    writeStoredAppearance(storage, { noteWidth: 'wide', fontSize: 18 })
    expect(readStoredAppearance(storage)).toEqual({ noteWidth: 'wide', fontSize: 18 })

    const corrupt = memoryStorage({ [APPEARANCE_STORAGE_KEY]: '{not json' })
    expect(readStoredAppearance(corrupt)).toEqual(DEFAULT_APPEARANCE)

    expect(readStoredAppearance(memoryStorage())).toEqual(DEFAULT_APPEARANCE)
    expect(readStoredAppearance(null)).toEqual(DEFAULT_APPEARANCE)
  })

  it('applies width and font size as inline CSS variables on the root', () => {
    applyAppearance({ noteWidth: 'narrow', fontSize: 13 })
    expect(document.documentElement.style.getPropertyValue('--sd-note-max-width')).toBe(NOTE_WIDTH_CSS.narrow)
    expect(document.documentElement.style.getPropertyValue('--sd-note-font-size')).toBe('13px')

    applyAppearance({ noteWidth: 'wide', fontSize: 20 })
    expect(document.documentElement.style.getPropertyValue('--sd-note-max-width')).toBe('none')
    expect(document.documentElement.style.getPropertyValue('--sd-note-font-size')).toBe('20px')
  })

  it('applyStoredAppearance restores persisted prefs (restart without flash)', () => {
    const storage = memoryStorage({ [APPEARANCE_STORAGE_KEY]: '{"noteWidth":"narrow","fontSize":12}' })
    const prefs = applyStoredAppearance(storage)
    expect(prefs).toEqual({ noteWidth: 'narrow', fontSize: 12 })
    expect(document.documentElement.style.getPropertyValue('--sd-note-max-width')).toBe(NOTE_WIDTH_CSS.narrow)
    expect(document.documentElement.style.getPropertyValue('--sd-note-font-size')).toBe('12px')
  })
})
