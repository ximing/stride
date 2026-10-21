import { has, register, Service } from '@rabjs/react'
import { i18n } from '../../i18n'
import {
  applyLocale,
  DEFAULT_LOCALE,
  defaultLocaleStorage,
  readStoredLocale,
  sanitizeLocale,
  writeStoredLocale,
  type AppLocale,
} from '../../i18n/locale'

export class LocaleService extends Service {
  locale: AppLocale = DEFAULT_LOCALE

  constructor() {
    super()
    this.locale = readStoredLocale(defaultLocaleStorage())
  }

  setLocale(locale: AppLocale) {
    this.locale = sanitizeLocale(locale)
    writeStoredLocale(defaultLocaleStorage(), this.locale)
    applyLocale(this.locale)
    void i18n.changeLanguage(this.locale)
  }

  apply() {
    this.locale = readStoredLocale(defaultLocaleStorage())
    applyLocale(this.locale)
    void i18n.changeLanguage(this.locale)
  }
}

if (!has(LocaleService)) register(LocaleService)
