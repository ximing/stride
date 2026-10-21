import { has, resolve } from '@rabjs/react'
import { beforeEach } from 'vitest'
import { LocaleService } from '../services/appearance/locale.service'
import { i18n } from './index'
import { applyLocale, LOCALE_STORAGE_KEY } from './locale'

beforeEach(async () => {
  if (typeof localStorage !== 'undefined') localStorage.removeItem(LOCALE_STORAGE_KEY)
  applyLocale('en')
  if (i18n.language !== 'en') await i18n.changeLanguage('en')
  if (has(LocaleService)) resolve(LocaleService).locale = 'en'
})
