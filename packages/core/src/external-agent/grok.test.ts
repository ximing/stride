import { VAULT_CLI_RULES, type AgentProcessTransport } from '@stride/platform'
import { describe, expect, it } from 'vitest'
import { GrokClient } from './grok.ts'

function grokHarness() {
  let onData: ((chunk: string) => void) | null = null
  const writes: Array<Record<string, unknown>> = []
  let kills = 0
  let promptId: number | null = null
  const emit = (value: unknown) => {
    onData?.(`${JSON.stringify(value)}\n`)
  }
  const transport: AgentProcessTransport = {
    write(data) {
      for (const line of data.split('\n')) {
        if (!line.trim()) continue
        const message = JSON.parse(line) as Record<string, unknown>
        writes.push(message)
        if (message.method === 'initialize') {
          emit({ jsonrpc: '2.0', id: message.id, result: { authMethods: [] } })
        } else if (message.method === 'session/new') {
          emit({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'grok-session' } })
        } else if (message.method === 'session/prompt') {
          promptId = typeof message.id === 'number' ? message.id : null
        } else if (message.method === 'session/cancel' || message.method === '$/cancel_request') {
          const requestId = message.method === '$/cancel_request'
            ? (message.params as { requestId?: unknown } | undefined)?.requestId
            : promptId
          if (typeof requestId === 'number') {
            emit({ jsonrpc: '2.0', id: requestId, error: { code: -32800, message: 'Request cancelled' } })
          }
        }
      }
      return Promise.resolve()
    },
    onData(listener) {
      onData = listener
      return () => {
        if (onData === listener) onData = null
      }
    },
    onExit() {
      return () => undefined
    },
    kill() {
      kills += 1
      return Promise.resolve()
    },
  }
  return { writes, transport, emit, kills: () => kills }
}

describe('grok rules and cancel', () => {
  it('puts rules inside session/new params and resolves -32800 without killing', async () => {
    const harness = grokHarness()
    const client = new GrokClient()
    await client.start(harness.transport, '/vault', AbortSignal.timeout(4000))
    const created = harness.writes.find((frame) => frame.method === 'session/new')
    expect(created?.params).toEqual({
      cwd: '/vault',
      mcpServers: [],
      _meta: { rules: VAULT_CLI_RULES },
    })
    expect(created).not.toHaveProperty('_meta')
    expect(JSON.stringify(created)).not.toContain('yoloMode')
    expect(harness.writes.some((frame) => frame.method === 'session/load' || frame.method === 'session/set_model')).toBe(false)

    const controller = new AbortController()
    const pending = client.prompt('hang', controller.signal, () => undefined)
    controller.abort()
    await expect(pending).resolves.toEqual({ stopped: true, killed: false })
    expect(harness.kills()).toBe(0)
    const prompt = harness.writes.find((frame) => frame.method === 'session/prompt')
    expect(harness.writes).toContainEqual({
      jsonrpc: '2.0',
      method: 'session/cancel',
      params: { sessionId: 'grok-session' },
    })
    expect(harness.writes).toContainEqual({
      jsonrpc: '2.0',
      method: '$/cancel_request',
      params: { requestId: prompt?.id },
    })
    expect(harness.writes.some((frame) => frame.method === 'session/close' || frame.method === 'session/load' || frame.method === 'session/set_model')).toBe(false)

    let text = ''
    const next = client.prompt('next', AbortSignal.timeout(4000), (delta) => {
      text += delta
    })
    const nextPrompt = harness.writes.filter((frame) => frame.method === 'session/prompt').at(-1)
    harness.emit({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'alpha' } } },
    })
    harness.emit({ jsonrpc: '2.0', id: nextPrompt?.id, result: { stopReason: 'end_turn' } })
    await expect(next).resolves.toEqual({ stopped: false, killed: false })
    expect(text).toBe('alpha')
    expect(harness.writes.filter((frame) => frame.method === 'session/new')).toHaveLength(1)
    expect(harness.kills()).toBe(0)
  })
})
