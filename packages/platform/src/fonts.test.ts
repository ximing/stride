import { describe, expect, it } from 'vitest'
import { isListableFontFamily, memorySystemFonts, normalizeSystemFontFamilies } from './fonts.ts'

describe('system font families', () => {
  it('keeps the first casing, drops private and CSS-unsafe names, and sorts', () => {
    const names = normalizeSystemFontFamilies([
      ' Songti SC ',
      'songti sc',
      '.LastResort',
      '@Vertical',
      'Bad;Font',
      'quote"ed',
      'stack, serif',
      '',
      'Georgia',
      '冬青黑体',
    ])
    expect(names).toEqual([...names].sort((left, right) => left.localeCompare(right, undefined, { sensitivity: 'base', numeric: true })))
    expect(names).toEqual(expect.arrayContaining(['Georgia', 'Songti SC', '冬青黑体']))
    expect(names).toHaveLength(3)
  })

  it('rejects names that cannot sit inside a quoted font-family', () => {
    expect(isListableFontFamily('Helvetica Neue')).toBe(true)
    expect(isListableFontFamily('stride:font-default')).toBe(false)
    expect(isListableFontFamily('a'.repeat(129))).toBe(false)
    expect(isListableFontFamily('ok\nname')).toBe(false)
  })

  it('memory catalog returns the normalized list', async () => {
    await expect(memorySystemFonts(['Georgia', 'Georgia', '.LastResort']).listFamilies())
      .resolves.toEqual(['Georgia'])
  })
})
