import { describe, expect, it } from 'vitest'
import manifest from '../appCommandManifest.json'
import { parseAppCommandManifest } from '../services/commands/commands'
import { en } from './en'
import { i18n } from './index'
import { zh } from './zh'

function leaves(value: unknown, prefix = ''): string[] {
  if (typeof value === 'string') return [prefix]
  if (!value || typeof value !== 'object') return []
  return Object.entries(value).flatMap(([key, child]) => leaves(child, prefix ? `${prefix}.${key}` : key))
}

describe('catalogs', () => {
  it('gives Chinese every English key', () => {
    expect(leaves(zh).sort()).toEqual(leaves(en).sort())
  })

  it('covers every command id in both catalogs', () => {
    const keys = new Set(leaves(en))
    const zhKeys = new Set(leaves(zh))
    for (const command of parseAppCommandManifest(manifest)) {
      const leaf = `commands.${command.id}`
      expect(keys.has(leaf), `en missing ${leaf}`).toBe(true)
      expect(zhKeys.has(leaf), `zh missing ${leaf}`).toBe(true)
    }
  })

  it('defaults to English and switches to Chinese', async () => {
    await i18n.changeLanguage('en')
    expect(i18n.t('settings.sections.appearance')).toBe('Appearance')
    expect(i18n.t('shell.indexProgress', { done: 2, total: 9 })).toBe('Index 2/9')
    await i18n.changeLanguage('zh')
    expect(i18n.t('settings.sections.appearance')).toBe('外观')
    expect(i18n.t('palette.askAbout', { prompt: '项目' })).toBe('向 AI 询问“项目”')
    await i18n.changeLanguage('en')
    expect(i18n.t('palette.askAbout', { prompt: '项目' })).toBe('Ask AI about “项目”')
    expect(i18n.t('palette.newOfType', { type: '项目' })).toBe('New 项目')
  })
})
