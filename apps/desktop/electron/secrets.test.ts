// @vitest-environment node
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerHostSecrets, SEAL_KEY_FILE_NAME, type HostSafeStorage, type HostSecretsEvent } from './secrets.ts'
import type { RendererTrust } from './security.ts'

const DEV = 'http://127.0.0.1:1421/'
const trust: RendererTrust = { packaged: false, devUrl: DEV }

function encodeKey(byte: number): string {
  return Buffer.alloc(32, byte).toString('base64')
}

function createSafeStorage(options?: {
  available?: boolean
  failDecrypt?: boolean
  passthrough?: boolean
}): HostSafeStorage & {
  encrypts: string[]
  decrypts: number
} {
  return {
    encrypts: [],
    decrypts: 0,
    isEncryptionAvailable: () => options?.available !== false,
    encryptString(plainText: string) {
      this.encrypts.push(plainText)
      return Buffer.from(`enc:${plainText}`, 'utf8')
    },
    decryptString(encrypted: Buffer) {
      this.decrypts += 1
      if (options?.failDecrypt) throw new Error('decrypt failed')
      const text = encrypted.toString('utf8')
      if (options?.passthrough) return text
      if (!text.startsWith('enc:')) throw new Error('decrypt failed')
      return text.slice(4)
    },
  }
}

describe('host seal key', () => {
  let root = ''
  let handlers: Map<string, (event: HostSecretsEvent, payload?: unknown) => unknown>
  let safe: ReturnType<typeof createSafeStorage>
  let platform: NodeJS.Platform
  let execs: Array<{ file: string; args: readonly string[] }>
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
  const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  const infoLog = vi.spyOn(console, 'info').mockImplementation(() => undefined)

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'stride-e03b-'))
    handlers = new Map()
    safe = createSafeStorage()
    platform = 'linux'
    execs = []
    registerHostSecrets({
      handle(channel, listener) {
        handlers.set(channel, listener)
      },
      getTrust: () => trust,
      userDataPath: () => root,
      safeStorage: safe,
      platform,
      execFile: async (file, args) => {
        execs.push({ file, args })
        throw new Error('security must be mocked')
      },
    })
  })

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true })
    log.mockClear()
    errorLog.mockClear()
    infoLog.mockClear()
  })

  function call(payload?: unknown, url = DEV) {
    const handler = handlers.get('secrets:getOrCreateKey')
    if (!handler) throw new Error('missing secrets:getOrCreateKey')
    return handler({ sender: { getURL: () => url } }, payload)
  }

  async function fileBytes(): Promise<Buffer | null> {
    try {
      return await readFile(join(root, SEAL_KEY_FILE_NAME))
    } catch {
      return null
    }
  }

  it('rejects an untrusted renderer before touching the seal file', async () => {
    expect(() => call(undefined, 'https://evil.example/')).toThrow(/untrusted renderer/)
    expect(await fileBytes()).toBeNull()
    expect(safe.encrypts).toEqual([])
    expect(execs).toEqual([])
  })

  it('persists a random 32-byte key as safeStorage ciphertext with mode 0600', async () => {
    const encoded = await call()
    expect(typeof encoded).toBe('string')
    const raw = Buffer.from(String(encoded), 'base64')
    expect(raw).toHaveLength(32)
    const bytes = await fileBytes()
    expect(bytes?.toString('utf8')).toBe(`enc:${encoded}`)
    expect(bytes?.includes(raw)).toBe(false)
    expect(String(encoded)).not.toContain(raw.toString('utf8'))
    expect((await stat(join(root, SEAL_KEY_FILE_NAME))).mode & 0o777).toBe(0o600)
    const again = await call()
    expect(again).toBe(encoded)
    expect(safe.encrypts).toEqual([encoded])
    expect(execs).toEqual([])
  })

  it('shares one in-flight create across overlapping calls', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let encrypts = 0
    handlers.clear()
    registerHostSecrets({
      handle(channel, listener) {
        handlers.set(channel, listener)
      },
      getTrust: () => trust,
      userDataPath: () => root,
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString(plain) {
          encrypts += 1
          return Buffer.from(`enc:${plain}`, 'utf8')
        },
        decryptString(encrypted) {
          const text = encrypted.toString('utf8')
          if (!text.startsWith('enc:')) throw new Error('decrypt failed')
          return text.slice(4)
        },
      },
      platform: 'linux',
      execFile: async () => {
        await gate
        throw new Error('unused')
      },
    })
    const pending = Promise.all([call(), call()])
    await vi.waitFor(() => {
      expect(encrypts).toBe(1)
    })
    release()
    const [first, second] = await pending
    expect(second).toBe(first)
    expect(encrypts).toBe(1)
    expect(Buffer.from(String(first), 'base64')).toHaveLength(32)
  })

  it('does not overwrite a file that fails to decrypt', async () => {
    const path = join(root, SEAL_KEY_FILE_NAME)
    const original = Buffer.from('not-a-seal', 'utf8')
    await writeFile(path, original, { mode: 0o600 })
    safe = createSafeStorage({ failDecrypt: true })
    handlers.clear()
    registerHostSecrets({
      handle(channel, listener) {
        handlers.set(channel, listener)
      },
      getTrust: () => trust,
      userDataPath: () => root,
      safeStorage: safe,
      platform: 'linux',
      execFile: async () => {
        throw new Error('security must be mocked')
      },
    })
    await expect(call()).rejects.toThrow('Failed to load the seal key')
    expect(await readFile(path)).toEqual(original)
    expect(safe.encrypts).toEqual([])
  })

  it('does not replace an existing key with a legacy key', async () => {
    const existing = encodeKey(1)
    const legacy = encodeKey(2)
    safe.encryptString(existing)
    await writeFile(join(root, SEAL_KEY_FILE_NAME), Buffer.from(`enc:${existing}`, 'utf8'))
    safe.encrypts.length = 0
    await expect(call({ legacy })).rejects.toThrow('Failed to move the seal key into the keychain')
    expect((await readFile(join(root, SEAL_KEY_FILE_NAME))).toString('utf8')).toBe(`enc:${existing}`)
    expect(safe.encrypts).toEqual([])
    await expect(call()).resolves.toBe(existing)
  })

  it('absorbs a later legacy before the first empty open chooses a key', async () => {
    const legacy = encodeKey(9)
    const [first, second] = await Promise.all([call(), call({ legacy })])
    expect(first).toBe(legacy)
    expect(second).toBe(legacy)
    expect(safe.encrypts).toEqual([legacy])
    expect((await fileBytes())?.toString('utf8')).toBe(`enc:${legacy}`)
  })

  it('fails two different legacy values before writing a seal file', async () => {
    const pending = Promise.allSettled([call({ legacy: encodeKey(3) }), call({ legacy: encodeKey(5) })])
    const [first, second] = await pending
    expect(first.status).toBe('rejected')
    expect(second.status).toBe('rejected')
    expect(await fileBytes()).toBeNull()
  })

  it('adopts a renderer legacy key when no seal file exists', async () => {
    const legacy = encodeKey(4)
    await expect(call({ legacy })).resolves.toBe(legacy)
    expect((await fileBytes())?.toString('utf8')).toBe(`enc:${legacy}`)
    expect(execs).toEqual([])
  })

  it('fails closed when safeStorage is unavailable and writes nothing', async () => {
    handlers.clear()
    const unavailable = createSafeStorage({ available: false })
    registerHostSecrets({
      handle(channel, listener) {
        handlers.set(channel, listener)
      },
      getTrust: () => trust,
      userDataPath: () => root,
      safeStorage: unavailable,
      platform: 'darwin',
      execFile: async () => {
        throw new Error('must not run')
      },
    })
    await expect(call()).rejects.toThrow('Safe storage is unavailable')
    expect(await fileBytes()).toBeNull()
    expect(unavailable.encrypts).toEqual([])
  })

  it('migrates the macOS keychain with a mocked security command', async () => {
    const migrated = encodeKey(9)
    handlers.clear()
    const calls: Array<{ file: string; args: readonly string[] }> = []
    registerHostSecrets({
      handle(channel, listener) {
        handlers.set(channel, listener)
      },
      getTrust: () => trust,
      userDataPath: () => root,
      safeStorage: safe,
      platform: 'darwin',
      execFile: async (file, args) => {
        calls.push({ file, args })
        return { stdout: `${migrated}\n`, stderr: '' }
      },
    })
    await expect(call()).resolves.toBe(migrated)
    expect(calls).toEqual([
      {
        file: 'security',
        args: ['find-generic-password', '-s', 'app.stride.desktop', '-a', 'seal-key', '-w'],
      },
    ])
    expect((await fileBytes())?.toString('utf8')).toBe(`enc:${migrated}`)
    expect((await fileBytes())?.includes(Buffer.from(migrated, 'base64'))).toBe(false)
    expect(safe.encrypts).toEqual([migrated])
    expect((await stat(join(root, SEAL_KEY_FILE_NAME))).mode & 0o777).toBe(0o600)
    await expect(call()).resolves.toBe(migrated)
    expect(safe.encrypts).toEqual([migrated])
    const logged = [...log.mock.calls, ...errorLog.mock.calls, ...infoLog.mock.calls].flat().join('\n')
    expect(logged).not.toContain(migrated)
  })

  it('creates a new key when the mocked keychain read fails and does not log the secret', async () => {
    handlers.clear()
    registerHostSecrets({
      handle(channel, listener) {
        handlers.set(channel, listener)
      },
      getTrust: () => trust,
      userDataPath: () => root,
      safeStorage: safe,
      platform: 'darwin',
      execFile: async () => {
        throw new Error('secret-from-keychain-should-not-leak sk-live')
      },
    })
    const created = String(await call())
    expect(Buffer.from(created, 'base64')).toHaveLength(32)
    expect(created).not.toContain('sk-live')
    expect(safe.encrypts).toEqual([created])
    const bytes = await fileBytes()
    expect(bytes?.toString('utf8')).toBe(`enc:${created}`)
    expect(bytes?.includes(Buffer.from(created, 'base64'))).toBe(false)
    expect((await stat(join(root, SEAL_KEY_FILE_NAME))).mode & 0o777).toBe(0o600)
    await expect(call()).resolves.toBe(created)
    expect(safe.encrypts).toEqual([created])
    const logged = [...log.mock.calls, ...errorLog.mock.calls, ...infoLog.mock.calls].flat().join('\n')
    expect(logged).not.toContain('sk-live')
    expect(logged).not.toContain(created)
  })

  it('reads an existing safeStorage ciphertext on macOS without rewriting it', async () => {
    const existing = encodeKey(6)
    const path = join(root, SEAL_KEY_FILE_NAME)
    await writeFile(path, Buffer.from(`enc:${existing}`, 'utf8'), { mode: 0o600 })
    handlers.clear()
    const macSafe = createSafeStorage()
    registerHostSecrets({
      handle(channel, listener) {
        handlers.set(channel, listener)
      },
      getTrust: () => trust,
      userDataPath: () => root,
      safeStorage: macSafe,
      platform: 'darwin',
      execFile: async () => {
        throw new Error('security must be mocked')
      },
    })
    await expect(call()).resolves.toBe(existing)
    expect(await readFile(path)).toEqual(Buffer.from(`enc:${existing}`, 'utf8'))
    expect(macSafe.encrypts).toEqual([])
    expect(execs).toEqual([])
  })

  it('rejects a plaintext base64 macOS seal file when decrypt would pass it through', async () => {
    const existing = encodeKey(8)
    const path = join(root, SEAL_KEY_FILE_NAME)
    const original = Buffer.from(existing, 'utf8')
    await writeFile(path, original, { mode: 0o600 })
    handlers.clear()
    const macSafe = createSafeStorage({ passthrough: true })
    registerHostSecrets({
      handle(channel, listener) {
        handlers.set(channel, listener)
      },
      getTrust: () => trust,
      userDataPath: () => root,
      safeStorage: macSafe,
      platform: 'darwin',
      execFile: async () => {
        throw new Error('security must be mocked')
      },
    })
    await expect(call()).rejects.toThrow('Failed to load the seal key')
    expect(await readFile(path)).toEqual(original)
    expect(macSafe.encrypts).toEqual([])
    expect(macSafe.decrypts).toBe(0)
  })

  it('does not overwrite a corrupt macOS seal file', async () => {
    const path = join(root, SEAL_KEY_FILE_NAME)
    const original = Buffer.from('not-a-seal', 'utf8')
    await writeFile(path, original, { mode: 0o600 })
    handlers.clear()
    const macSafe = createSafeStorage({ failDecrypt: true })
    registerHostSecrets({
      handle(channel, listener) {
        handlers.set(channel, listener)
      },
      getTrust: () => trust,
      userDataPath: () => root,
      safeStorage: macSafe,
      platform: 'darwin',
      execFile: async () => {
        throw new Error('security must be mocked')
      },
    })
    await expect(call()).rejects.toThrow('Failed to load the seal key')
    expect(await readFile(path)).toEqual(original)
    expect(macSafe.encrypts).toEqual([])
  })
})
