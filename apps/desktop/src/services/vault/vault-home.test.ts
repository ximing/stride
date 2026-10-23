import { register, resolve } from '@rabjs/react'
import { DEDICATED_FOLDER_ERROR } from '@stride/core'
import { BROWSER_HOME_SENTINEL } from '@stride/fs-web'
import { MemoryFileSystem } from '@stride/platform'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { hostHomeDirectory } from '../platform/home'
import { VAULT_REGISTRY_KEY, VaultService } from './vault.service'

const homeMock = vi.hoisted(() => ({ value: '/Users/ximing' }))

vi.mock('@stride/fs-tauri', () => ({
  tauriHostPaths: () => ({
    homeDirectory: async () => homeMock.value,
  }),
}))

function setDesktop(on: boolean) {
  const win = window as unknown as {
    __TAURI_INTERNALS__?: {
      invoke: () => Promise<void>
      metadata: { currentWindow: { label: string } }
    }
  }
  if (on) {
    win.__TAURI_INTERNALS__ = {
      invoke: async () => undefined,
      metadata: { currentWindow: { label: 'main' } },
    }
  } else {
    delete win.__TAURI_INTERNALS__
  }
}

function useMemoryFixture() {
  window.history.replaceState(null, '', '/?fixture=memory')
}

function freshVault(): VaultService {
  register(VaultService)
  const vault = resolve(VaultService)
  vault.phase = 'chooser'
  vault.error = ''
  vault.fs = null
  vault.broad = false
  vault.vaultPath = ''
  vault.notes = []
  return vault
}

describe('vault home directory', () => {
  afterEach(async () => {
    // reportOpenProject imports the window API after the open returns.
    for (let step = 0; step < 4; step += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    setDesktop(false)
    window.history.replaceState(null, '', '/')
    localStorage.removeItem(VAULT_REGISTRY_KEY)
    homeMock.value = '/Users/ximing'
  })

  it('uses a browser sentinel that is not /Users/stride', async () => {
    setDesktop(false)
    const home = await hostHomeDirectory()
    expect(home).toBe(BROWSER_HOME_SENTINEL)
    expect(home).not.toBe('/Users/stride')
    expect(home).not.toBe('/Users/ximing')
  })

  it('uses the desktop home from the Tauri adapter', async () => {
    setDesktop(true)
    homeMock.value = '/Users/ximing'
    await expect(hostHomeDirectory()).resolves.toBe('/Users/ximing')
    homeMock.value = '/Users/stride'
    await expect(hostHomeDirectory()).resolves.toBe('/Users/stride')
  })

  it('does not write .stride/vault.json when the opened root is the desktop home', async () => {
    setDesktop(true)
    for (const home of ['/Users/ximing', '/Users/stride']) {
      homeMock.value = home
      const vault = freshVault()
      const fs = new MemoryFileSystem(home)
      await vault.openClonedVault(fs)
      expect(vault.error).toBe('')
      expect(vault.broad).toBe(true)
      expect(await fs.stat('.stride/vault.json')).toBeNull()
    }
  })

  it('does not treat /Users/ximing or /Users/stride as home in the browser', async () => {
    setDesktop(false)
    for (const root of ['/Users/ximing', '/Users/stride']) {
      const vault = freshVault()
      const fs = new MemoryFileSystem(root)
      await vault.openClonedVault(fs)
      expect(vault.error).toBe('')
      expect(vault.broad).toBe(false)
      expect(await fs.stat('.stride/vault.json')).not.toBeNull()
    }
  })

  it('does not write .stride/vault.json on the browser sentinel', async () => {
    setDesktop(false)
    const vault = freshVault()
    const fs = new MemoryFileSystem(BROWSER_HOME_SENTINEL)
    await vault.openClonedVault(fs)
    expect(vault.broad).toBe(true)
    expect(await fs.stat('.stride/vault.json')).toBeNull()
  })

  it('does not initialize a vault rooted at the desktop home', async () => {
    setDesktop(true)
    homeMock.value = 'memory-vault'
    useMemoryFixture()
    const vault = freshVault()
    await vault.createNewVault()
    expect(vault.error).toBe(DEDICATED_FOLDER_ERROR)
    expect(vault.fs).toBeNull()
    expect(vault.phase).toBe('chooser')
  })
})
