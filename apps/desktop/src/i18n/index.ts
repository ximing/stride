import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import { en } from './en'
import { applyStoredLocale, defaultLocaleStorage, readStoredLocale } from './locale'
import { zh } from './zh'

const locale = applyStoredLocale(defaultLocaleStorage())

void i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    zh: { translation: zh },
  },
  lng: readStoredLocale(defaultLocaleStorage()),
  fallbackLng: 'en',
  supportedLngs: ['en', 'zh'],
  initAsync: false,
  interpolation: { escapeValue: false },
  returnNull: false,
  react: { useSuspense: false },
})

export { i18n }

export function t(key: string, options?: Record<string, unknown>): string {
  return i18n.t(key, options)
}

/** Manifest titles stay English. The palette and shortcut list show this. */
export function commandTitle(id: string, fallback: string): string {
  return i18n.t(`commands.${id}`, { defaultValue: fallback })
}

export function watchLocale(apply: () => void): () => void {
  const onChange = () => apply()
  i18n.on('languageChanged', onChange)
  return () => {
    i18n.off('languageChanged', onChange)
  }
}

void locale
