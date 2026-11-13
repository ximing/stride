import { afterEach, describe, expect, expectTypeOf, it } from 'vitest'
import { ELECTRON_BRIDGE_KEY } from './index.ts'
import {
  checkForUpdate,
  downloadUpdate,
  installUpdate,
  onUpdaterEvent,
  relaunchAfterUpdate,
  type UpdateOffer,
  type UpdaterEvent,
} from './updater.ts'

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[ELECTRON_BRIDGE_KEY]
})

function install(invoke: (channel: string, args?: unknown) => unknown, on?: (channel: string, listener: (payload: unknown) => void) => () => void) {
  Object.defineProperty(globalThis, ELECTRON_BRIDGE_KEY, {
    value: {
      invoke,
      on: on ?? (() => () => undefined),
    },
    configurable: true,
    writable: true,
  })
}

const offer: UpdateOffer = {
  version: '1.2.0',
  body: 'Fixes',
  date: '2026-11-01',
  currentVersion: '1.0.0',
}

describe('stable updater helpers', () => {
  it('checks, downloads, installs, and relaunches on the updater channels', async () => {
    const seen: string[] = []
    install(async (channel) => {
      seen.push(channel)
      return channel === 'updater:check' ? offer : undefined
    })
    await expect(checkForUpdate()).resolves.toEqual(offer)
    await downloadUpdate()
    await installUpdate()
    await relaunchAfterUpdate()
    expect(seen).toEqual(['updater:check', 'updater:download', 'updater:install', 'updater:relaunch'])
    expectTypeOf(checkForUpdate).returns.resolves.toEqualTypeOf<UpdateOffer | null>()
  })

  it('returns null when the host has no update and rejects a malformed offer', async () => {
    install(async () => null)
    await expect(checkForUpdate()).resolves.toBeNull()
    install(async () => ({ version: '1.2.0' }))
    await expect(checkForUpdate()).rejects.toThrow(/Rejected update check/)
  })

  it('forwards only Started, Progress, and Finished events', () => {
    let notify: ((payload: unknown) => void) | null = null
    install(async () => undefined, (_channel, listener) => {
      notify = listener
      return () => {
        notify = null
      }
    })
    const seen: UpdaterEvent[] = []
    const dispose = onUpdaterEvent((event) => {
      seen.push(event)
    })
    const emit = (payload: unknown): void => {
      if (notify) notify(payload)
    }
    emit({ type: 'Started', version: '1.2.0' })
    emit({ type: 'Progress', version: '1.2.0', percent: 10, transferred: 1, total: 10 })
    emit({ type: 'Finished', version: '1.2.0' })
    emit({ type: 'error', message: 'https://example.invalid/secret' })
    expect(seen).toEqual([
      { type: 'Started', version: '1.2.0' },
      { type: 'Progress', version: '1.2.0', percent: 10, transferred: 1, total: 10 },
      { type: 'Finished', version: '1.2.0' },
    ])
    dispose()
  })
})
