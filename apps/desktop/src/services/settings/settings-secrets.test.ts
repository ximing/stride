import { register, resolve } from '@rabjs/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resetSecretsStore, SETTINGS_STORAGE_KEY, SettingsService } from './settings.service'

const factories = vi.hoisted(() => ({
  electron: vi.fn(),
  web: vi.fn(),
}))

vi.mock('@stride/secrets-electron', () => ({
  electronSecretsStore: factories.electron,
}))

vi.mock('@stride/secrets-web', () => ({
  webSecretsStore: factories.web,
}))

function passthrough() {
  return {
    async seal(value: string) {
      return value
    },
    async open(value: string) {
      if (value === 'sealed-embed') return 'sk-live-browser-key'
      return ''
    },
  }
}

function setDesktop(on: boolean) {
  const win = window as unknown as { __STRIDE_ELECTRON__?: Record<string, unknown> }
  if (on) win.__STRIDE_ELECTRON__ = {}
  else delete win.__STRIDE_ELECTRON__
}

describe('settings secret host', () => {
  afterEach(() => {
    setDesktop(false)
    vi.unstubAllGlobals()
    localStorage.removeItem(SETTINGS_STORAGE_KEY)
    resetSecretsStore()
    factories.electron.mockReset()
    factories.web.mockReset()
  })

  it('uses the electron store on the desktop runtime even when IndexedDB exists', async () => {
    setDesktop(true)
    const idbOpen = vi.fn(() => {
      throw new Error('indexedDB.open')
    })
    vi.stubGlobal('indexedDB', { open: idbOpen })
    factories.electron.mockResolvedValue(passthrough())
    register(SettingsService)
    await resolve(SettingsService).load()
    expect(factories.electron).toHaveBeenCalledTimes(1)
    expect(factories.web).not.toHaveBeenCalled()
    expect(idbOpen).not.toHaveBeenCalled()
  })

  it('uses the web store in the browser and still masks the opened key', async () => {
    setDesktop(false)
    vi.stubGlobal('indexedDB', {})
    factories.web.mockResolvedValue(passthrough())
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({
      embedding: { endpoint: 'http://127.0.0.1/v1', model: 'm', keySeal: 'sealed-embed', keyMask: 'stale', dim: 4 },
    }))
    register(SettingsService)
    const settings = resolve(SettingsService)
    await settings.load()
    expect(factories.web).toHaveBeenCalledTimes(1)
    expect(factories.electron).not.toHaveBeenCalled()
    expect(settings.form.embedding.keyMask).toBe('••••-key')
    expect(settings.notice).toBe('')
  })

  it('does not call either store when the browser has no IndexedDB', async () => {
    setDesktop(false)
    vi.stubGlobal('indexedDB', undefined)
    register(SettingsService)
    const settings = resolve(SettingsService)
    await settings.load()
    expect(factories.electron).not.toHaveBeenCalled()
    expect(factories.web).not.toHaveBeenCalled()
    expect(settings.notice).toBe('')
  })

  it('surfaces a desktop store failure and leaves the saved ciphertext', async () => {
    setDesktop(true)
    const saved = '{"embedding":{"keySeal":"keep-me"}}'
    localStorage.setItem(SETTINGS_STORAGE_KEY, saved)
    factories.electron.mockRejectedValue(new Error('Failed to move the seal key into the keychain'))
    register(SettingsService)
    const settings = resolve(SettingsService)
    await settings.load()
    expect(settings.notice).toBe('Failed to move the seal key into the keychain')
    expect(localStorage.getItem(SETTINGS_STORAGE_KEY)).toBe(saved)
    expect(factories.web).not.toHaveBeenCalled()
  })
})
