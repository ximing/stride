import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import {
  ELECTRON_BRIDGE_KEY,
  ELECTRON_EVENT_CHANNELS,
  ELECTRON_EVENT_CHANNEL_SET,
  ELECTRON_REQUEST_CHANNELS,
  ELECTRON_REQUEST_CHANNEL_SET,
  type AppInfo,
  type ElectronBridge,
  type ElectronEventChannel,
  type ElectronRequestChannel,
  type WindowControlAction,
  type WindowStateSnapshot,
  electronBridge,
  isElectronEventChannel,
  isElectronRequestChannel,
} from './index.ts'

const REQUEST_CHANNELS = [
  'app:info',
  'app:exit',
  'app:relaunch',
  'host:home',
  'host:fetch',
  'host:fetchAbort',
  'host:fonts',
  'host:openExternal',
  'dialog:pickDirectory',
  'fs:readText',
  'fs:readBytes',
  'fs:writeText',
  'fs:writeBytes',
  'fs:list',
  'fs:mkdir',
  'fs:rename',
  'fs:remove',
  'fs:stat',
  'fs:lstat',
  'fs:watch',
  'fs:unwatch',
  'git:exec',
  'secrets:getOrCreateKey',
  'shell:spawn',
  'shell:cancel',
  'agent:spawn',
  'agent:write',
  'agent:kill',
  'agent:which',
  'agent:probe',
  'window:intent',
  'window:setProject',
  'window:new',
  'window:newProject',
  'window:openProject',
  'window:control',
  'window:state',
  'window:syncRecent',
  'updater:check',
  'updater:download',
  'updater:install',
  'updater:relaunch',
] as const

const EVENT_CHANNELS = [
  'fs:event',
  'host:fetch:event',
  'shell:event',
  'agent:event',
  'window:intent',
  'window:recent',
  'window:state',
  'deep-link:open',
  'updater:event',
] as const

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[ELECTRON_BRIDGE_KEY]
})

describe('electron channels', () => {
  it('lists the exact request and event channels once each', () => {
    expect(ELECTRON_BRIDGE_KEY).toBe('__STRIDE_ELECTRON__')
    expect([...ELECTRON_REQUEST_CHANNELS]).toEqual([...REQUEST_CHANNELS])
    expect([...ELECTRON_EVENT_CHANNELS]).toEqual([...EVENT_CHANNELS])
    expect(new Set(ELECTRON_REQUEST_CHANNELS).size).toBe(ELECTRON_REQUEST_CHANNELS.length)
    expect(new Set(ELECTRON_EVENT_CHANNELS).size).toBe(ELECTRON_EVENT_CHANNELS.length)
    expect([...ELECTRON_REQUEST_CHANNEL_SET]).toEqual([...REQUEST_CHANNELS])
    expect([...ELECTRON_EVENT_CHANNEL_SET]).toEqual([...EVENT_CHANNELS])
    expect(ELECTRON_REQUEST_CHANNELS.filter((channel) => isElectronEventChannel(channel))).toEqual([
      'window:intent',
      'window:state',
    ])
  })

  it('freezes the channel arrays and sets', () => {
    expect(Object.isFrozen(ELECTRON_REQUEST_CHANNELS)).toBe(true)
    expect(Object.isFrozen(ELECTRON_EVENT_CHANNELS)).toBe(true)
    expect(Object.isFrozen(ELECTRON_REQUEST_CHANNEL_SET)).toBe(true)
    expect(Object.isFrozen(ELECTRON_EVENT_CHANNEL_SET)).toBe(true)
    expect(() => {
      ;(ELECTRON_REQUEST_CHANNELS as unknown as string[]).push('extra')
    }).toThrow(TypeError)
    expect(() => {
      ;(ELECTRON_EVENT_CHANNELS as unknown as string[]).push('extra')
    }).toThrow(TypeError)
    expect(() => {
      Set.prototype.add.call(ELECTRON_REQUEST_CHANNEL_SET, 'extra')
    }).toThrow(TypeError)
    expect(ELECTRON_REQUEST_CHANNEL_SET.size).toBe(REQUEST_CHANNELS.length)
  })

  it('guards request channels, event channels, and the shared names', () => {
    for (const channel of REQUEST_CHANNELS) {
      expect(isElectronRequestChannel(channel)).toBe(true)
    }
    for (const channel of EVENT_CHANNELS) {
      expect(isElectronEventChannel(channel)).toBe(true)
    }
    expect(isElectronRequestChannel('window:intent')).toBe(true)
    expect(isElectronEventChannel('window:intent')).toBe(true)
    expect(isElectronRequestChannel('window:state')).toBe(true)
    expect(isElectronEventChannel('window:state')).toBe(true)
    expect(isElectronRequestChannel('fs:event')).toBe(false)
    expect(isElectronEventChannel('fs:readText')).toBe(false)
    expect(isElectronRequestChannel('nope')).toBe(false)
    expect(isElectronEventChannel('')).toBe(false)
    expect(isElectronRequestChannel(1)).toBe(false)
    expect(isElectronEventChannel(null)).toBe(false)
    expect(isElectronRequestChannel(undefined)).toBe(false)
  })

  it('exports the bridge payload types', () => {
    expectTypeOf<AppInfo>().toEqualTypeOf<{ version: string; platform: string }>()
    expectTypeOf<WindowControlAction>().toEqualTypeOf<'close' | 'minimize' | 'toggleMaximize'>()
    expectTypeOf<WindowStateSnapshot>().toEqualTypeOf<{
      maximized: boolean
      minimized: boolean
      fullscreen: boolean
    }>()
    expectTypeOf<ElectronBridge['invoke']>().toBeFunction()
    expectTypeOf<ElectronBridge['on']>().toBeFunction()
  })
})

describe('electronBridge', () => {
  it('throws a clear error when the bridge is missing or the wrong shape', () => {
    expect(() => electronBridge()).toThrow(/missing or has the wrong shape/)
    for (const value of [null, 1, 'bridge', undefined]) {
      install(value)
      expect(() => electronBridge()).toThrow(/missing or has the wrong shape/)
    }
    install({})
    expect(() => electronBridge()).toThrow(/invoke is not a function/)
    install({ invoke() {}, on: 'nope' })
    expect(() => electronBridge()).toThrow(/on is not a function/)
    install({ invoke: 'nope', on() {} })
    expect(() => electronBridge()).toThrow(/invoke is not a function/)
  })

  it('wraps a present bridge without exposing the raw object', async () => {
    const raw = {
      ipcRenderer: { send: vi.fn() },
      invoke: vi.fn(async (channel: string, args?: unknown) => ({ channel, args })),
      on: vi.fn(() => vi.fn()),
    }
    install(raw)
    const bridge = electronBridge()
    expect(bridge).not.toBe(raw)
    expect(bridge).not.toHaveProperty('ipcRenderer')
    expect(Object.keys(bridge).sort()).toEqual(['invoke', 'on'])
    await expect(bridge.invoke('host:home')).resolves.toEqual({ channel: 'host:home', args: undefined })
    expect(raw.invoke).toHaveBeenCalledWith('host:home')
    await expect(bridge.invoke('host:fetch', { url: 'http://127.0.0.1' })).resolves.toEqual({
      channel: 'host:fetch',
      args: { url: 'http://127.0.0.1' },
    })
    expect(raw.invoke).toHaveBeenLastCalledWith('host:fetch', { url: 'http://127.0.0.1' })
  })

  it('rejects unknown request and event channels before calling the raw bridge', () => {
    const invoke = vi.fn()
    const on = vi.fn()
    install({ invoke, on })
    const bridge = electronBridge()
    expect(() => bridge.invoke('fs:event' as ElectronRequestChannel)).toThrow(
      /unknown Electron request channel: "fs:event"/,
    )
    expect(() => bridge.invoke('nope' as ElectronRequestChannel)).toThrow(/unknown Electron request channel/)
    expect(() => bridge.on('fs:readText' as ElectronEventChannel, () => {})).toThrow(
      /unknown Electron event channel: "fs:readText"/,
    )
    expect(() => bridge.on('nope' as ElectronEventChannel, () => {})).toThrow(/unknown Electron event channel/)
    expect(invoke).not.toHaveBeenCalled()
    expect(on).not.toHaveBeenCalled()
  })

  it('rejects a non-function listener and still accepts both shared channels', () => {
    const on = vi.fn(() => vi.fn())
    install({ invoke: vi.fn(), on })
    const bridge = electronBridge()
    for (const listener of [undefined, null, 1, 'listener', {}]) {
      expect(() => bridge.on('fs:event', listener as (payload: unknown) => void)).toThrow(
        /listener for "fs:event" must be a function/,
      )
    }
    expect(on).not.toHaveBeenCalled()
    bridge.on('window:intent', () => {})
    bridge.on('window:state', () => {})
    expect(on).toHaveBeenCalledTimes(2)
  })

  it('forwards only the event payload and makes the disposer idempotent', () => {
    const seen: unknown[][] = []
    let disposals = 0
    install({
      invoke: vi.fn(),
      on(_channel: string, listener: (...args: unknown[]) => void) {
        listener({ kind: 'changed' }, { sender: 'electron' }, 'extra')
        return () => {
          disposals += 1
        }
      },
    })
    const bridge = electronBridge()
    const dispose = bridge.on('shell:event', (...args: unknown[]) => {
      seen.push(args)
    })
    expect(seen).toEqual([[{ kind: 'changed' }]])
    dispose()
    dispose()
    dispose()
    expect(disposals).toBe(1)
  })

  it('calls a throwing disposer once', () => {
    let disposals = 0
    install({
      invoke: vi.fn(),
      on() {
        return () => {
          disposals += 1
          throw new Error('already unsubscribed')
        }
      },
    })
    const dispose = electronBridge().on('deep-link:open', () => {})
    expect(() => dispose()).toThrow(/already unsubscribed/)
    expect(() => dispose()).not.toThrow()
    expect(disposals).toBe(1)
  })

  it('keeps invoke and on bound to the raw bridge object', async () => {
    const raw = {
      marker: 'raw',
      invoke(this: { marker: string }, channel: string) {
        return Promise.resolve(`${this.marker}:${channel}`)
      },
      on(this: { marker: string }, channel: string, listener: (payload: unknown) => void) {
        listener(`${this.marker}:${channel}`)
        return () => {}
      },
    }
    install(raw)
    const bridge = electronBridge()
    await expect(bridge.invoke('app:info')).resolves.toBe('raw:app:info')
    let payload = ''
    bridge.on('updater:event', (value: string) => {
      payload = value
    })
    expect(payload).toBe('raw:updater:event')
  })
})

function install(value: unknown) {
  Object.defineProperty(globalThis, ELECTRON_BRIDGE_KEY, {
    value,
    configurable: true,
    writable: true,
  })
}
