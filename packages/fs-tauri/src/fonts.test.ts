import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.hoisted(() => vi.fn())

vi.mock('@tauri-apps/api/core', () => ({
  invoke,
}))

import { tauriSystemFonts } from './fonts.ts'

describe('tauriSystemFonts', () => {
  beforeEach(() => {
    invoke.mockReset()
  })

  it('asks the shell for installed families and drops unsafe names', async () => {
    invoke.mockResolvedValue(['Songti SC', 'Songti SC', '.LastResort', 'Bad;Font', 'Georgia'])
    await expect(tauriSystemFonts().listFamilies()).resolves.toEqual(['Georgia', 'Songti SC'])
    expect(invoke).toHaveBeenCalledWith('list_font_families')
  })

  it('returns nothing when the shell answer is not a list', async () => {
    invoke.mockResolvedValue(null)
    await expect(tauriSystemFonts().listFamilies()).resolves.toEqual([])
  })
})
