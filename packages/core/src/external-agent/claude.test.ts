import type { AgentProcessTransport } from '@stride/platform'
import { describe, expect, it } from 'vitest'
import { ClaudeClient } from './claude.ts'

function claudeHarness() {
  let onData: ((chunk: string) => void) | null = null
  const writes: Array<Record<string, unknown>> = []
  let kills = 0
  const transport: AgentProcessTransport = {
    write(data) {
      for (const line of data.split('\n')) {
        if (!line.trim()) continue
        writes.push(JSON.parse(line) as Record<string, unknown>)
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
  const emit = (value: unknown) => {
    onData?.(`${JSON.stringify(value)}\n`)
  }
  return {
    writes,
    transport,
    emit,
    kills: () => kills,
  }
}

async function startedClaude(): Promise<ReturnType<typeof claudeHarness> & { client: ClaudeClient }> {
  const harness = claudeHarness()
  const client = new ClaudeClient()
  const pending = client.start(harness.transport, AbortSignal.timeout(4000))
  harness.emit({ type: 'system', subtype: 'init', session_id: 'claude-session' })
  await pending
  return { ...harness, client }
}

describe('claude interrupt', () => {
  it('does not finish the turn on control_response alone', async () => {
    const { client, emit } = await startedClaude()
    const pending = client.prompt('hello', AbortSignal.timeout(4000), () => undefined)
    emit({
      type: 'control_response',
      response: { subtype: 'interrupt', request_id: 'req-1' },
    })
    const early = await Promise.race([
      pending.then(() => 'settled'),
      new Promise((resolve) => setTimeout(resolve, 30, 'pending')),
    ])
    expect(early).toBe('pending')
    emit({ type: 'result', subtype: 'success', result: 'alpha', is_error: false })
    await expect(pending).resolves.toEqual({ stopped: false, killed: false })
  })

  it('writes an interrupt and waits for result before resolving a user stop', async () => {
    const { client, emit, writes, kills } = await startedClaude()
    let release = (): void => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const seen = writes.length
    const controller = new AbortController()
    const first = client.prompt('hang', controller.signal, () => undefined)
    await Promise.resolve()
    controller.abort()
    await Promise.resolve()
    const interrupt = writes.slice(seen).find((frame) => frame.type === 'control_request')
    expect(interrupt?.request).toEqual({ subtype: 'interrupt' })
    expect(interrupt?.request_id).toMatch(/^[0-9a-f]{32}$/)
    expect(JSON.stringify(interrupt)).not.toContain('cancel_queued')
    emit({
      type: 'control_response',
      response: { subtype: 'interrupt', request_id: interrupt?.request_id },
    })
    const early = await Promise.race([
      first.then(() => 'settled'),
      new Promise((resolve) => setTimeout(resolve, 30, 'pending')),
    ])
    expect(early).toBe('pending')
    expect(kills()).toBe(0)
    void gate.then(() => {
      emit({ type: 'result', subtype: 'success', session_id: 'claude-session', result: '', is_error: false })
    })
    release()
    await expect(first).resolves.toEqual({ stopped: true, killed: false })

    const second = client.prompt('next', AbortSignal.timeout(4000), () => undefined)
    emit({ type: 'result', subtype: 'success', result: 'alpha', is_error: false })
    await expect(second).resolves.toEqual({ stopped: false, killed: false })
    expect(kills()).toBe(0)
  })
})
