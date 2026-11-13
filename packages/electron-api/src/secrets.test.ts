import { afterEach, describe, expect, expectTypeOf, it } from 'vitest'
import { ELECTRON_BRIDGE_KEY } from './index.ts'
import { getOrCreateSealKey, type SealKeyRequest } from './secrets.ts'

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[ELECTRON_BRIDGE_KEY]
})

function install(invoke: (channel: string, args?: unknown) => unknown) {
  Object.defineProperty(globalThis, ELECTRON_BRIDGE_KEY, {
    value: { invoke, on: () => () => undefined },
    configurable: true,
    writable: true,
  })
}

describe('getOrCreateSealKey', () => {
  it('invokes secrets:getOrCreateKey and returns the base64 key', async () => {
    const seen: unknown[] = []
    install(async (channel, args) => {
      seen.push({ channel, args })
      return 'AAAA'
    })
    await expect(getOrCreateSealKey()).resolves.toBe('AAAA')
    await expect(getOrCreateSealKey('bbbb')).resolves.toBe('AAAA')
    expect(seen).toEqual([
      { channel: 'secrets:getOrCreateKey', args: undefined },
      { channel: 'secrets:getOrCreateKey', args: { legacy: 'bbbb' } },
    ])
    expectTypeOf(getOrCreateSealKey).parameter(0).toEqualTypeOf<string | undefined>()
    expectTypeOf(getOrCreateSealKey).returns.resolves.toBeString()
    expectTypeOf<SealKeyRequest>().toEqualTypeOf<{ legacy?: string }>()
  })

  it('rejects a result that is not a non-empty string', async () => {
    install(async () => '')
    await expect(getOrCreateSealKey()).rejects.toThrow(/invalid seal key/)
    install(async () => 1)
    await expect(getOrCreateSealKey()).rejects.toThrow(/invalid seal key/)
  })
})
