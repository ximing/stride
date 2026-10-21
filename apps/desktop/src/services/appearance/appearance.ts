// Pure note-appearance logic: note width + editor font size values,
// localStorage (de)serialization, and applying both as CSS variables on the
// document root. Mirrors theme.ts: no rabjs or React dependencies, so it stays
// unit-testable and safe to run at module scope before the first paint (the
// pre-paint call site lives in theme.service.ts, which main.tsx imports).

import { normalizeFontSize, normalizeNoteWidth, type AppearanceSettings, type NoteWidth } from '@stride/core'

export type AppearancePrefs = AppearanceSettings

export const APPEARANCE_STORAGE_KEY = 'stride:appearance'

export const DEFAULT_APPEARANCE: AppearancePrefs = { noteWidth: 'standard', fontSize: 15 }

export const NOTE_WIDTHS: readonly NoteWidth[] = ['narrow', 'standard', 'wide']

/** max-width applied to the note column for each width setting. */
export const NOTE_WIDTH_CSS: Record<NoteWidth, string> = {
  narrow: '36rem',
  standard: '44rem',
  wide: 'none',
}

export const NOTE_FONT_SIZE_MIN = 12
export const NOTE_FONT_SIZE_MAX = 20

export function isValidNoteFontSize(value: number): boolean {
  return Number.isInteger(value) && value >= NOTE_FONT_SIZE_MIN && value <= NOTE_FONT_SIZE_MAX
}

export function sanitizeAppearance(value: unknown): AppearancePrefs {
  const record = typeof value === 'object' && value !== null
    ? (value as { noteWidth?: unknown; fontSize?: unknown })
    : {}
  return {
    noteWidth: normalizeNoteWidth(record.noteWidth),
    fontSize: normalizeFontSize(record.fontSize),
  }
}

/** Minimal storage contract so tests can pass a fake; localStorage satisfies it. */
export interface AppearanceStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export function defaultAppearanceStorage(): AppearanceStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

export function readStoredAppearance(storage: AppearanceStorage | null): AppearancePrefs {
  if (!storage) return DEFAULT_APPEARANCE
  try {
    const raw = storage.getItem(APPEARANCE_STORAGE_KEY)
    if (raw === null) return DEFAULT_APPEARANCE
    return sanitizeAppearance(JSON.parse(raw))
  } catch {
    return DEFAULT_APPEARANCE
  }
}

export function writeStoredAppearance(storage: AppearanceStorage | null, prefs: AppearancePrefs): void {
  if (!storage) return
  try {
    storage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify(sanitizeAppearance(prefs)))
  } catch {
    // Quota or privacy-mode failures must never break appearance switching.
  }
}

/**
 * Apply the prefs to the root element as inline CSS variables, which beat the
 * :root defaults in styles.css. Instant: no restart, no repaint of the shell.
 */
export function applyAppearance(prefs: AppearancePrefs, root?: HTMLElement | null): void {
  const target = root ?? (typeof document === 'undefined' ? null : document.documentElement)
  if (!target) return
  const next = sanitizeAppearance(prefs)
  target.style.setProperty('--sd-note-max-width', NOTE_WIDTH_CSS[next.noteWidth])
  target.style.setProperty('--sd-note-font-size', `${next.fontSize}px`)
}

/**
 * Synchronously re-apply the persisted prefs. Runs before the first paint via
 * theme.service.ts (imported by main.tsx at module scope), so the note column
 * never flashes the default width/size.
 */
export function applyStoredAppearance(storage: AppearanceStorage | null = defaultAppearanceStorage()): AppearancePrefs {
  const prefs = readStoredAppearance(storage)
  applyAppearance(prefs)
  return prefs
}
