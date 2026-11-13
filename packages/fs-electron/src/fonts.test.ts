import { beforeEach, describe, expect, it, vi } from 'vitest'

const listSystemFonts = vi.hoisted(() => vi.fn())

vi.mock('@stride/electron-api', () => ({
  listSystemFonts,
}))

import { electronSystemFonts } from './fonts.ts'

describe('electronSystemFonts', () => {
  beforeEach(() => {
    listSystemFonts.mockReset()
  })

  it('asks the host for installed families and drops unsafe names', async () => {
    listSystemFonts.mockResolvedValue(['Songti SC', 'Songti SC', '.LastResort', 'Bad;Font', 'Georgia'])
    await expect(electronSystemFonts().listFamilies()).resolves.toEqual(['Georgia', 'Songti SC'])
    expect(listSystemFonts).toHaveBeenCalledOnce()
  })

  it('returns nothing when the host answer is not a list', async () => {
    listSystemFonts.mockResolvedValue([])
    await expect(electronSystemFonts().listFamilies()).resolves.toEqual([])
  })
})
