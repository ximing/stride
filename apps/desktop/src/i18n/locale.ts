// App-wide UI language. Stored in localStorage, like the theme, so it applies
// before the first paint and follows the app rather than a vault folder.
// `.stride/vault.json` and the settings blob must not carry this value.

export const LOCALES = ['en', 'zh'] as const

export type AppLocale = (typeof LOCALES)[number]

export const DEFAULT_LOCALE: AppLocale = 'en'

export const LOCALE_STORAGE_KEY = 'stride:locale'

export function sanitizeLocale(value: unknown): AppLocale {
  return value === 'zh' || value === 'en' ? value : DEFAULT_LOCALE
}

/** BCP 47 tag written on <html lang>. */
export function localeLang(locale: AppLocale): string {
  return locale === 'zh' ? 'zh-CN' : 'en'
}

export interface LocaleStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export function defaultLocaleStorage(): LocaleStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

export function readStoredLocale(storage: LocaleStorage | null): AppLocale {
  if (!storage) return DEFAULT_LOCALE
  try {
    return sanitizeLocale(storage.getItem(LOCALE_STORAGE_KEY))
  } catch {
    return DEFAULT_LOCALE
  }
}

export function writeStoredLocale(storage: LocaleStorage | null, locale: AppLocale): void {
  if (!storage) return
  try {
    storage.setItem(LOCALE_STORAGE_KEY, sanitizeLocale(locale))
  } catch {
    // Quota or privacy-mode failures must never break language switching.
  }
}

export function applyLocale(locale: AppLocale, root?: HTMLElement | null): AppLocale {
  const next = sanitizeLocale(locale)
  const target = root ?? (typeof document === 'undefined' ? null : document.documentElement)
  if (target) target.lang = localeLang(next)
  return next
}

export function applyStoredLocale(storage: LocaleStorage | null = defaultLocaleStorage()): AppLocale {
  return applyLocale(readStoredLocale(storage))
}
