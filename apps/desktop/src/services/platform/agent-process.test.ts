import { has, register, resolve } from '@rabjs/react'
import { agentSpawnSpec, VAULT_CLI_RULES } from '@stride/platform'
import { ExternalAgentSession } from '@stride/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsService } from '../settings/settings.service'
import { resolveAgentProcessHost } from './agent-process'

/**
 * Claude writes its system/init line as soon as the process starts, which can
 * be before `spawnAgent` resolves and before the client calls `onData`.
 * The desktop host must keep that stdout until the first subscriber.
 */
const ipc = vi.hoisted(() => {
  const listeners = new Set<(payload: unknown) => void>()
  const writes: string[] = []
  const requests: Array<{ command: string; args: string[]; cwd: string }> = []
  let release: ((id: string) => void) | null = null
  let markOpened: (() => void) | null = null
  let opened = new Promise<void>((resolve) => {
    markOpened = resolve
  })
  return {
    writes,
    requests,
    get opened() {
      return opened
    },
    reset() {
      listeners.clear()
      writes.length = 0
      requests.length = 0
      release = null
      opened = new Promise<void>((resolve) => {
        markOpened = resolve
      })
    },
    emit(payload: unknown) {
      for (const listener of listeners) listener(payload)
    },
    release(id: string) {
      release?.(id)
    },
    onAgentEvent(listener: (payload: unknown) => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    spawnAgent(request: { command: string; args: string[]; cwd: string }) {
      requests.push({ command: request.command, args: [...request.args], cwd: request.cwd })
      return new Promise<string>((resolve) => {
        release = resolve
        markOpened?.()
      })
    },
    async writeAgent(_id: string, data: string) {
      writes.push(data)
    },
    async killAgent() {},
  }
})

vi.mock('@stride/electron-api', () => ({
  onAgentEvent: ipc.onAgentEvent,
  spawnAgent: ipc.spawnAgent,
  writeAgent: ipc.writeAgent,
  killAgent: ipc.killAgent,
}))

const INIT = `${JSON.stringify({ type: 'system', subtype: 'init', session_id: 'claude-session' })}\n`
const ASSISTANT = `${JSON.stringify({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'text', text: 'pong' }] },
})}\n`
const RESULT = `${JSON.stringify({ type: 'result', subtype: 'success', session_id: 'claude-session', result: 'pong' })}\n`

describe('desktop agent stdout', () => {
  beforeEach(() => {
    ipc.reset()
  })

  afterEach(() => {
    delete (window as { __STRIDE_ELECTRON__?: unknown }).__STRIDE_ELECTRON__
  })

  it('keeps Claude init stdout that arrives before spawnAgent resolves', async () => {
    ;(window as { __STRIDE_ELECTRON__?: unknown }).__STRIDE_ELECTRON__ = {}
    if (has(SettingsService)) {
      const settings = resolve(SettingsService)
      settings.form = {
        ...settings.form,
        agent: {
          ...settings.form.agent,
          executables: { grok: null, claude: null, codex: null },
        },
      }
    }
    const spec = agentSpawnSpec('claude')
    const session = new ExternalAgentSession(resolveAgentProcessHost(), 'claude', '/vault')
    let text = ''
    const turn = session.prompt('ping', AbortSignal.timeout(4000), (delta) => {
      text += delta
    })
    await ipc.opened
    ipc.emit({ id: 'agent-1', event: 'stdout', data: INIT })
    ipc.release('agent-1')
    await vi.waitUntil(() => ipc.writes.some((chunk) => chunk.includes('ping')))
    ipc.emit({ id: 'agent-1', event: 'stdout', data: ASSISTANT + RESULT })
    await turn
    expect(text).toBe('pong')
    expect(ipc.requests).toEqual([{
      command: spec.command,
      args: [...spec.args, '--append-system-prompt', VAULT_CLI_RULES],
      cwd: '/vault',
    }])
    expect(ipc.requests[0]?.args ?? []).not.toContain('--model')
    expect(ipc.writes.join('')).not.toContain('--model')
    expect(ipc.writes.join('')).not.toContain('session/set_model')
    await session.stop()
  })

  it('spawns a configured executable and keeps an empty path on the bare name', async () => {
    ;(window as { __STRIDE_ELECTRON__?: unknown }).__STRIDE_ELECTRON__ = {}
    if (!has(SettingsService)) register(SettingsService)
    const settings = resolve(SettingsService)
    settings.form = {
      ...settings.form,
      agent: {
        ...settings.form.agent,
        executables: { grok: null, claude: '/opt/bin/claude', codex: '' },
      },
    }
    const claudeArgs = [...agentSpawnSpec('claude').args]
    const pending = resolveAgentProcessHost().spawn({ command: 'claude', args: claudeArgs, cwd: '/vault' })
    await ipc.opened
    ipc.release('agent-1')
    await pending
    expect(ipc.requests).toEqual([{ command: '/opt/bin/claude', args: claudeArgs, cwd: '/vault' }])

    ipc.reset()
    const codexArgs = [...agentSpawnSpec('codex').args]
    const pendingCodex = resolveAgentProcessHost().spawn({ command: 'codex', args: codexArgs, cwd: '/vault' })
    await ipc.opened
    ipc.release('agent-2')
    await pendingCodex
    expect(ipc.requests).toEqual([{ command: 'codex', args: codexArgs, cwd: '/vault' }])
  })
})
