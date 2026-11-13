import { afterEach, describe, expect, expectTypeOf, it } from 'vitest'
import { ELECTRON_BRIDGE_KEY, type WatchEvent } from './index.ts'
import {
  decodeFileBytes,
  encodeFileBytes,
  homeDir,
  pickDirectory,
  readFile,
  watch,
  writeFile,
} from './fs.ts'

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[ELECTRON_BRIDGE_KEY]
})

function install(raw: { invoke: (channel: string, args?: unknown) => unknown; on: (channel: string, listener: (payload: unknown) => void) => () => void }) {
  Object.defineProperty(globalThis, ELECTRON_BRIDGE_KEY, { value: raw, configurable: true, writable: true })
}

describe('file bytes', () => {
  it('restores base64 and byte arrays to a Uint8Array and rejects damaged input', () => {
    const bytes = new Uint8Array([0, 1, 255, 10, 32])
    expect(Array.from(decodeFileBytes(encodeFileBytes(bytes)))).toEqual([...bytes])
    expect(Array.from(decodeFileBytes([0, 1, 255]))).toEqual([0, 1, 255])
    expect(Array.from(decodeFileBytes(bytes))).toEqual([...bytes])
    expect(decodeFileBytes('')).toEqual(new Uint8Array())
    for (const bad of ['abc', '====', '@@@@', [1.5], [-1], [256], {}, null]) {
      expect(() => decodeFileBytes(bad)).toThrow(/invalid file bytes/)
    }
  })

  it('sends base64 on write and returns Uint8Array on read', async () => {
    const seen: unknown[] = []
    install({
      invoke: async (channel, args) => {
        seen.push({ channel, args })
        if (channel === 'fs:readBytes') return encodeFileBytes(new Uint8Array([7, 8]))
        return undefined
      },
      on: () => () => {},
    })
    await writeFile('/tmp/a.bin', new Uint8Array([9, 0]))
    expect(seen[0]).toEqual({ channel: 'fs:writeBytes', args: { path: '/tmp/a.bin', data: encodeFileBytes(new Uint8Array([9, 0])) } })
    await expect(readFile('/tmp/a.bin')).resolves.toEqual(new Uint8Array([7, 8]))
    install({
      invoke: async () => [4, 5],
      on: () => () => {},
    })
    await expect(readFile('/tmp/a.bin')).resolves.toEqual(new Uint8Array([4, 5]))
  })
})

describe('watch', () => {
  it('returns a stop function and delivers only the matching watch id', async () => {
    const listeners: Array<(payload: unknown) => void> = []
    const invokes: unknown[] = []
    install({
      invoke: async (channel, args) => {
        invokes.push({ channel, args })
        if (channel === 'fs:watch') return { id: 7 }
        return undefined
      },
      on: (_channel, listener) => {
        listeners.push(listener)
        return () => {
          const index = listeners.indexOf(listener)
          if (index >= 0) listeners.splice(index, 1)
        }
      },
    })
    const seen: WatchEvent[] = []
    const stop = await watch('/tmp/vault', (event) => {
      seen.push(event)
    })
    expectTypeOf(stop).toEqualTypeOf<() => void>()
    expect(listeners).toHaveLength(1)
    listeners[0]?.({ id: 3, path: '/tmp/other', kind: 'create' })
    listeners[0]?.({ id: 7, path: '/tmp/vault/note.txt', kind: 'modify' })
    listeners[0]?.({ id: 7, path: '/tmp/vault/note.txt', kind: 'remove' })
    listeners[0]?.({ id: 7, path: '/tmp/vault/note.txt', kind: 'access' })
    expect(seen).toEqual([
      { type: { modify: { kind: 'any' } }, paths: ['/tmp/vault/note.txt'], attrs: {} },
      { type: { remove: { kind: 'any' } }, paths: ['/tmp/vault/note.txt'], attrs: {} },
    ])
    stop()
    stop()
    expect(listeners).toHaveLength(0)
    expect(invokes.filter((call) => (call as { channel: string }).channel === 'fs:unwatch')).toEqual([
      { channel: 'fs:unwatch', args: { id: 7 } },
    ])
  })

  it('flushes events that arrive before fs:watch resolves, in order, and ignores other ids', async () => {
    const listeners: Array<(payload: unknown) => void> = []
    install({
      invoke: async (channel) => {
        if (channel !== 'fs:watch') return undefined
        listeners[0]?.({ id: 4, path: '/tmp/vault/first.txt', kind: 'create' })
        listeners[0]?.({ id: 11, path: '/tmp/other/nope.txt', kind: 'modify' })
        listeners[0]?.({ id: 4, path: '/tmp/vault/second.txt', kind: 'remove' })
        return { id: 4 }
      },
      on: (_channel, listener) => {
        listeners.push(listener)
        return () => {
          const index = listeners.indexOf(listener)
          if (index >= 0) listeners.splice(index, 1)
        }
      },
    })
    const seen: WatchEvent[] = []
    const stop = await watch('/tmp/vault', (event) => {
      seen.push(event)
    })
    listeners[0]?.({ id: 4, path: '/tmp/vault/third.txt', kind: 'modify' })
    listeners[0]?.({ id: 11, path: '/tmp/other/later.txt', kind: 'create' })
    expect(seen).toEqual([
      { type: { create: { kind: 'any' } }, paths: ['/tmp/vault/first.txt'], attrs: {} },
      { type: { remove: { kind: 'any' } }, paths: ['/tmp/vault/second.txt'], attrs: {} },
      { type: { modify: { kind: 'any' } }, paths: ['/tmp/vault/third.txt'], attrs: {} },
    ])
    stop()
  })

  it('does not surface an unhandled rejection when unwatch loses the race', async () => {
    install({
      invoke: (channel) => {
        if (channel === 'fs:watch') return { id: 3 }
        return Promise.reject(new Error('watch already closed'))
      },
      on: () => () => {},
    })
    const reasons: unknown[] = []
    const onUnhandled = (reason: unknown) => {
      reasons.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      const stop = await watch('/tmp/vault', () => {})
      stop()
      stop()
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(reasons).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('unwatches once when a buffered callback throws during flush', async () => {
    const listeners: Array<(payload: unknown) => void> = []
    const invokes: unknown[] = []
    let disposed = 0
    install({
      invoke: async (channel, args) => {
        invokes.push({ channel, args })
        if (channel === 'fs:watch') {
          listeners[0]?.({ id: 9, path: '/tmp/vault/boom.txt', kind: 'modify' })
          return { id: 9 }
        }
        return Promise.reject(new Error('unwatch failed'))
      },
      on: (_channel, listener) => {
        listeners.push(listener)
        return () => {
          disposed += 1
          const index = listeners.indexOf(listener)
          if (index >= 0) listeners.splice(index, 1)
        }
      },
    })
    const reasons: unknown[] = []
    const onUnhandled = (reason: unknown) => {
      reasons.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      await expect(watch('/tmp/vault', () => {
        throw new Error('callback failed')
      })).rejects.toThrow(/callback failed/)
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(listeners).toHaveLength(0)
      expect(disposed).toBe(1)
      expect(invokes.filter((call) => (call as { channel: string }).channel === 'fs:unwatch')).toEqual([
        { channel: 'fs:unwatch', args: { id: 9 } },
      ])
      expect(reasons).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('drops the listener when fs:watch rejects', async () => {
    let disposed = 0
    install({
      invoke: async () => {
        throw new Error('watch failed')
      },
      on: () => () => {
        disposed += 1
      },
    })
    await expect(watch('/tmp/vault', () => {})).rejects.toThrow(/watch failed/)
    expect(disposed).toBe(1)
  })
})

describe('host helpers', () => {
  it('calls home and directory dialog channels', async () => {
    install({
      invoke: async (channel) => (channel === 'host:home' ? '/Users/me' : null),
      on: () => () => {},
    })
    await expect(homeDir()).resolves.toBe('/Users/me')
    await expect(pickDirectory()).resolves.toBeNull()
  })
})
