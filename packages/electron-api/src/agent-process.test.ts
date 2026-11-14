import { afterEach, describe, expect, it, vi } from 'vitest'
import { ELECTRON_BRIDGE_KEY } from './index.ts'
import { probeAgent, whichAgents } from './agent-process.ts'

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[ELECTRON_BRIDGE_KEY]
})

describe('whichAgents', () => {
  it('reads absolute paths and drops empty or non-string fields', async () => {
    const invoke = vi.fn(async (channel: string) => {
      expect(channel).toBe('agent:which')
      return { grok: '/opt/grok', claude: '  ', codex: 4, extra: true }
    })
    ;(globalThis as Record<string, unknown>)[ELECTRON_BRIDGE_KEY] = {
      invoke,
      on: () => () => undefined,
    }
    await expect(whichAgents()).resolves.toEqual({ grok: '/opt/grok', claude: null, codex: null })
  })
})

describe('probeAgent', () => {
  it('invokes agent:probe and returns the resolved path', async () => {
    const invoke = vi.fn(async (channel: string, payload: unknown) => {
      expect(channel).toBe('agent:probe')
      expect(payload).toEqual({ command: '/opt/claude', mode: 'claude' })
      return { found: true, resolved: '/opt/claude' }
    })
    ;(globalThis as Record<string, unknown>)[ELECTRON_BRIDGE_KEY] = {
      invoke,
      on: () => () => undefined,
    }
    await expect(probeAgent({ command: '/opt/claude', mode: 'claude' })).resolves.toEqual({
      found: true,
      resolved: '/opt/claude',
    })
  })
})
