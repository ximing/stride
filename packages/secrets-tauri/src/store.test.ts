import { beforeEach, describe, expect, it, vi } from 'vitest'
import indexSource from './index.ts?raw'
import storeSource from './store.ts?raw'
import * as api from './index.ts'

const keyring = vi.hoisted(() => {
  const entries = new Map<string, string>()
  const calls: string[] = []
  const id = (service: string, user: string) => `${service}\0${user}`
  return {
    entries,
    calls,
    reset() {
      entries.clear()
      calls.length = 0
    },
    async getPassword(service: string, user: string): Promise<string | null> {
      calls.push(`get ${service} ${user}`)
      return entries.get(id(service, user)) ?? null
    },
    async setPassword(service: string, user: string, password: string): Promise<void> {
      calls.push(`set ${service} ${user}`)
      entries.set(id(service, user), password)
    },
  }
})

vi.mock('tauri-plugin-keyring-api', () => ({
  getPassword: keyring.getPassword,
  setPassword: keyring.setPassword,
}))

function encodeBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]!)
  return btoa(binary)
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function copyBytes(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buffer).set(bytes)
  return buffer
}

function storedPassword(): string {
  const value = keyring.entries.get('app.stride.desktop\0seal-key')
  if (value == null) throw new Error('seal key was not stored')
  return value
}

async function decryptLayout(rawKey: Uint8Array, sealed: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', copyBytes(rawKey), { name: 'AES-GCM' }, false, ['decrypt'])
  const packed = decodeBase64(sealed)
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: copyBytes(packed.subarray(0, 12)) },
    key,
    copyBytes(packed.subarray(12)),
  )
  return new TextDecoder().decode(plain)
}

describe('tauriSecretsStore', () => {
  beforeEach(() => {
    keyring.reset()
  })

  it('seals and opens an empty string as empty', async () => {
    const store = await api.tauriSecretsStore()
    expect(await store.seal('')).toBe('')
    expect(await store.open('')).toBe('')
  })

  it('round-trips a non-empty string as base64 of iv and ciphertext-with-tag', async () => {
    const store = await api.tauriSecretsStore()
    const sealed = await store.seal('sk-live-secret')
    expect(sealed).toMatch(/^[A-Za-z0-9+/]+={0,2}$/)
    expect(sealed).not.toBe('sk-live-secret')
    const packed = decodeBase64(sealed)
    expect(packed.length).toBe(12 + new TextEncoder().encode('sk-live-secret').length + 16)
    expect(await store.open(sealed)).toBe('sk-live-secret')
    const raw = decodeBase64(storedPassword())
    expect(raw).toHaveLength(32)
    expect(await decryptLayout(raw, sealed)).toBe('sk-live-secret')
  })

  it('opens a seal from a second instance that reads the same key', async () => {
    const first = await api.tauriSecretsStore()
    const sealed = await first.seal('shared-secret')
    const persisted = storedPassword()
    keyring.calls.length = 0
    const second = await api.tauriSecretsStore()
    expect(second).not.toBe(first)
    expect(keyring.calls).toEqual(['get app.stride.desktop seal-key'])
    expect(storedPassword()).toBe(persisted)
    expect(await second.open(sealed)).toBe('shared-secret')
    expect(await first.open(sealed)).toBe('shared-secret')
  })

  it('fails open with io when the keychain key is different', async () => {
    const store = await api.tauriSecretsStore()
    const sealed = await store.seal('top-secret')
    const other = new Uint8Array(32)
    other[0] = 9
    keyring.entries.set('app.stride.desktop\0seal-key', encodeBase64(other))
    const mismatched = await api.tauriSecretsStore()
    await expect(mismatched.open(sealed)).rejects.toMatchObject({ name: 'PlatformError', code: 'io' })
    expect(await store.open(sealed)).toBe('top-secret')
  })

  it('stores a random 32-byte key as base64 under the desktop service account', async () => {
    await api.tauriSecretsStore()
    expect(keyring.calls).toEqual([
      'get app.stride.desktop seal-key',
      'set app.stride.desktop seal-key',
    ])
    const raw = decodeBase64(storedPassword())
    expect(raw).toHaveLength(32)
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('stride-settings-v1')))
    expect(raw).not.toEqual(digest)
    expect(storedPassword()).not.toBe('stride-settings-v1')
  })

  it('does not reimplement maskSecret', () => {
    const source = `${indexSource}\n${storeSource}`
    expect(source).not.toContain('maskSecret')
    expect(source).not.toContain('••••')
    expect(source).not.toContain('stride-settings-v1')
    expect(source).not.toContain('deriveKey')
    expect(Object.keys(api).sort()).toEqual(['tauriSecretsStore'])
    expect(api).not.toHaveProperty('maskSecret')
  })
})
