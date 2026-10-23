import { describe, expect, it } from 'vitest'
import { memoryHostPaths } from './host.ts'

describe('memoryHostPaths', () => {
  it('returns the home string it was given', async () => {
    await expect(memoryHostPaths('/Users/ximing').homeDirectory()).resolves.toBe('/Users/ximing')
    await expect(memoryHostPaths('\0stride-browser-home').homeDirectory()).resolves.toBe('\0stride-browser-home')
  })
})
