import { resolve } from '@rabjs/react'
import { afterEach, describe, expect, it } from 'vitest'
import { i18n } from '../../i18n'
import { LOCALE_STORAGE_KEY } from '../../i18n/locale'
import { SETTINGS_STORAGE_KEY } from '../settings/settings.service'
import { LocaleService } from './locale.service'

describe('LocaleService', () => {
  afterEach(async () => {
    localStorage.removeItem(LOCALE_STORAGE_KEY)
    document.documentElement.lang = 'en'
    resolve(LocaleService).locale = 'en'
    await i18n.changeLanguage('en')
  })

  it('defaults to English and does not touch vault or app settings', async () => {
    localStorage.removeItem(LOCALE_STORAGE_KEY)
    localStorage.setItem(SETTINGS_STORAGE_KEY, '{"keep":true}')
    const locale = resolve(LocaleService)
    locale.apply()
    await i18n.changeLanguage('en')
    expect(locale.locale).toBe('en')
    expect(i18n.t('locale.label')).toBe('Language')
    expect(localStorage.getItem(SETTINGS_STORAGE_KEY)).toBe('{"keep":true}')
  })

  it('persists the choice globally and switches copy immediately', async () => {
    const locale = resolve(LocaleService)
    locale.setLocale('zh')
    await i18n.changeLanguage('zh')
    expect(locale.locale).toBe('zh')
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('zh')
    expect(document.documentElement.lang).toBe('zh-CN')
    expect(i18n.t('locale.label')).toBe('语言')
    locale.setLocale('en')
    await i18n.changeLanguage('en')
    expect(i18n.t('settings.title')).toBe('Settings')
  })

  it('ignores an unknown stored value', () => {
    localStorage.setItem(LOCALE_STORAGE_KEY, 'fr')
    const locale = resolve(LocaleService)
    locale.apply()
    expect(locale.locale).toBe('en')
    expect(document.documentElement.lang).toBe('en')
  })
})
