import { describe, expect, it } from 'vitest'
import { MemoryFileSystem } from '@stride/platform'
import { isBroadPersonalRoot } from './roots.ts'
import { DEDICATED_FOLDER_ERROR, initializeVault } from './seed.ts'
import { openVault } from './vault.ts'

const SENTINEL = '\0stride-browser-home'

describe('isBroadPersonalRoot home argument', () => {
  it('treats a path equal to the provided home as broad', () => {
    expect(isBroadPersonalRoot('/Users/ximing', '/Users/ximing')).toBe(true)
    expect(isBroadPersonalRoot('/home/ada', '/home/ada')).toBe(true)
    expect(isBroadPersonalRoot('/Users/ximing', '/Users/ximing/')).toBe(true)
    expect(isBroadPersonalRoot('/Users/ximing/', '/Users/ximing')).toBe(true)
  })

  it('treats /Users/ximing as broad only when that string is the home', () => {
    expect(isBroadPersonalRoot('/Users/ximing', '/Users/ximing')).toBe(true)
    expect(isBroadPersonalRoot('/Users/ximing', SENTINEL)).toBe(false)
    expect(isBroadPersonalRoot('/Users/stride', '/Users/stride')).toBe(true)
    expect(isBroadPersonalRoot('/Users/stride', SENTINEL)).toBe(false)
  })
})

describe('vault marker on the provided home', () => {
  it('does not write .stride/vault.json when opening or initializing that home', async () => {
    for (const home of ['/Users/ximing', '/Users/stride', '/Users/ximing/']) {
      const openedFs = new MemoryFileSystem(home.replace(/\/$/, ''))
      const opened = await openVault(openedFs, home)
      expect(opened.broad).toBe(true)
      expect(await openedFs.stat('.stride/vault.json')).toBeNull()

      const created = new MemoryFileSystem(home.replace(/\/$/, ''))
      await expect(initializeVault(created, home)).rejects.toThrow(DEDICATED_FOLDER_ERROR)
      expect(await created.stat('.stride/vault.json')).toBeNull()
    }
  })

  it('still marks /Users/ximing when the home argument is a different sentinel', async () => {
    const fs = new MemoryFileSystem('/Users/ximing')
    const opened = await openVault(fs, SENTINEL)
    expect(opened.broad).toBe(false)
    expect(await fs.stat('.stride/vault.json')).not.toBeNull()
  })
})
