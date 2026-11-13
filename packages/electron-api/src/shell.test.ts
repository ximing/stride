import { afterEach, describe, expect, expectTypeOf, it } from 'vitest'
import { ELECTRON_BRIDGE_KEY } from './index.ts'
import { cancelShell, onShellEvent, spawnShell, type ShellEvent, type ShellSpawnRequest } from './shell.ts'

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[ELECTRON_BRIDGE_KEY]
})

function install(
  invoke: (channel: string, args?: unknown) => unknown,
  on?: (channel: string, listener: (payload: unknown) => void) => () => void,
) {
  Object.defineProperty(globalThis, ELECTRON_BRIDGE_KEY, {
    value: {
      invoke,
      on: on ?? (() => () => undefined),
    },
    configurable: true,
    writable: true,
  })
}

describe('shell renderer channel', () => {
  it('spawns with command, cwd, and the original timeoutMs', async () => {
    const seen: unknown[] = []
    install(async (channel, args) => {
      seen.push({ channel, args })
      return 'abc'
    })
    const request: ShellSpawnRequest = { command: 'echo hi', cwd: '/vault', timeoutMs: 20.4 }
    await expect(spawnShell(request)).resolves.toBe('abc')
    await expect(spawnShell({ command: 'echo hi', cwd: '/vault' })).resolves.toBe('abc')
    expect(seen).toEqual([
      { channel: 'shell:spawn', args: { command: 'echo hi', cwd: '/vault', timeoutMs: 20.4 } },
      { channel: 'shell:spawn', args: { command: 'echo hi', cwd: '/vault' } },
    ])
    expectTypeOf(spawnShell).returns.resolves.toEqualTypeOf<string>()
  })

  it('rejects a spawn result that is not a session id', async () => {
    install(async () => 1)
    await expect(spawnShell({ command: 'echo', cwd: '/vault' })).rejects.toThrow(/invalid shell id/)
    install(async () => '')
    await expect(spawnShell({ command: 'echo', cwd: '/vault' })).rejects.toThrow(/invalid shell id/)
  })

  it('rejects a spawn body that is not command and cwd', async () => {
    install(async () => 'abc')
    await expect(spawnShell({ command: 1, cwd: '/vault' } as unknown as ShellSpawnRequest)).rejects.toThrow(
      /invalid shell request/,
    )
    await expect(spawnShell({ command: 'echo', cwd: '/vault', timeoutMs: Number.NaN })).rejects.toThrow(
      /invalid shell request/,
    )
  })

  it('cancels with the session id', async () => {
    const seen: unknown[] = []
    install(async (channel, args) => {
      seen.push({ channel, args })
    })
    await cancelShell('job-1')
    expect(seen).toEqual([{ channel: 'shell:cancel', args: { id: 'job-1' } }])
    await expect(cancelShell('')).rejects.toThrow(/invalid shell request/)
  })

  it('subscribes to shell:event and returns the bridge disposer', () => {
    const listeners: Array<(payload: unknown) => void> = []
    let disposed = 0
    install(
      async () => 'abc',
      (channel, listener) => {
        expect(channel).toBe('shell:event')
        listeners.push(listener)
        return () => {
          disposed += 1
        }
      },
    )
    const dispose = onShellEvent(() => {})
    expect(listeners).toHaveLength(1)
    dispose()
    dispose()
    expect(disposed).toBe(1)
    const event: ShellEvent = { id: 'job-1', event: 'started' }
    expect(event.event).toBe('started')
  })
})
