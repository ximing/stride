import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PlatformError } from '@stride/platform'

const homeDir = vi.hoisted(() => vi.fn(async () => '/Users/ximing'))

vi.mock('@tauri-apps/api/path', () => ({
  homeDir,
}))

import { tauriHostPaths } from './home.ts'

describe('tauriHostPaths', () => {
  beforeEach(() => {
    homeDir.mockReset()
    homeDir.mockResolvedValue('/Users/ximing')
  })

  it('returns the host home directory', async () => {
    await expect(tauriHostPaths().homeDirectory()).resolves.toBe('/Users/ximing')
    homeDir.mockResolvedValue('/Users/stride/')
    await expect(tauriHostPaths().homeDirectory()).resolves.toBe('/Users/stride/')
  })

  it('does not invent a home when the host returns nothing', async () => {
    homeDir.mockResolvedValue('')
    await expect(tauriHostPaths().homeDirectory()).rejects.toBeInstanceOf(PlatformError)
  })
})
