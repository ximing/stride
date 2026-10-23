import { describe, expect, it } from 'vitest'
import { BROWSER_HOME_SENTINEL, browserHostPaths } from './home.ts'

describe('browserHostPaths', () => {
  it('returns a sentinel that is not a pickable vault path', async () => {
    const home = await browserHostPaths().homeDirectory()
    expect(home).toBe(BROWSER_HOME_SENTINEL)
    expect(home).not.toBe('/Users/stride')
    expect(home).not.toBe('/Users/ximing')
    expect(home.includes('\0')).toBe(true)
    expect(home.includes('/')).toBe(false)
    expect(/^[A-Za-z]:/.test(home)).toBe(false)
  })
})
