import { describe, expect, it } from 'vitest'
import { collectBrowserFontFamilies } from './fonts.ts'

describe('browser font catalog', () => {
  it('dedupes families from the local font API and skips the probe', async () => {
    const names = await collectBrowserFontFamilies({
      queryLocalFonts: async () => [
        { family: 'Songti SC' },
        { family: 'Songti SC' },
        { family: '.LastResort' },
        { family: 'Nope;x' },
        { family: 'Georgia' },
      ],
      measure: () => true,
    })
    expect(names).toEqual(['Georgia', 'Songti SC'])
  })

  it('probes a known list when enumeration is denied or empty', async () => {
    const denied = await collectBrowserFontFamilies({
      queryLocalFonts: async () => {
        throw new Error('NotAllowedError')
      },
      measure: (family) => family === 'Georgia' || family === 'PingFang SC',
    })
    expect(denied).toEqual(['Georgia', 'PingFang SC'])

    const empty = await collectBrowserFontFamilies({
      queryLocalFonts: async () => [],
      measure: (family) => family === 'Songti SC',
    })
    expect(empty).toEqual(['Songti SC'])
  })
})
