import { afterEach, describe, expect, it } from 'vitest'
import { ELECTRON_BRIDGE_KEY } from './index.ts'
import { listSystemFonts } from './fonts.ts'

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

describe('listSystemFonts', () => {
  it('invokes host:fonts and keeps string names', async () => {
    const seen: string[] = []
    install(async (channel) => {
      seen.push(channel)
      return ['Georgia', 1, 'Songti SC']
    })
    await expect(listSystemFonts()).resolves.toEqual(['Georgia', 'Songti SC'])
    expect(seen).toEqual(['host:fonts'])
  })

  it('returns an empty list when the host answer is not a list', async () => {
    install(async () => null)
    await expect(listSystemFonts()).resolves.toEqual([])
  })
})
