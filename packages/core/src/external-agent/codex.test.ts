import { VAULT_CLI_RULES, type AgentProcessTransport } from '@stride/platform'
import { describe, expect, it } from 'vitest'
import { CodexClient } from './codex.ts'
import type { ExternalActivity } from './rpc.ts'

function scripted(respond: (message: Record<string, unknown>, emit: (value: unknown) => void) => void): AgentProcessTransport {
  let emitChunk: ((chunk: string) => void) | null = null
  const emit = (value: unknown) => {
    emitChunk?.(`${JSON.stringify(value)}\n`)
  }
  return {
    write(data: string) {
      for (const line of data.split('\n')) {
        if (!line.trim()) continue
        respond(JSON.parse(line) as Record<string, unknown>, emit)
      }
      return Promise.resolve()
    },
    onData(listener) {
      emitChunk = listener
      return () => {
        if (emitChunk === listener) emitChunk = null
      }
    },
    onExit() {
      return () => undefined
    },
    kill() {
      return Promise.resolve()
    },
  }
}

describe('codex turn id and approvals', () => {
  it('keeps turn.id and does not answer a permissions request', async () => {
    const writes: Array<Record<string, unknown>> = []
    const replies: Array<Record<string, unknown>> = []
    let turns = 0
    const transport = scripted((message, emit) => {
      if (message.method == null) {
        replies.push(message)
        return
      }
      writes.push(message)
      if (message.method === 'initialize') {
        emit({ jsonrpc: '2.0', id: message.id, result: {} })
        return
      }
      if (message.method === 'initialized') return
      if (message.method === 'thread/start') {
        emit({ jsonrpc: '2.0', id: message.id, result: { thread: { id: 'thread-1' } } })
        return
      }
      if (message.method !== 'turn/start') return
      turns += 1
      const turn = turns === 1
        ? { id: 'turn-a', status: 'inProgress', items: [] }
        : turns === 2
          ? { id: 'turn-b', status: 'inProgress', items: [] }
          : { status: 'inProgress', items: [] }
      if (turns === 2) {
        emit({
          jsonrpc: '2.0',
          id: 9004,
          method: 'item/permissions/requestApproval',
          params: {
            permissions: { fileSystem: { read: ['/etc'] }, network: { enabled: true } },
          },
        })
        emit({
          jsonrpc: '2.0',
          id: 9001,
          method: 'item/commandExecution/requestApproval',
          params: { itemId: 'cmd-1' },
        })
      }
      emit({ jsonrpc: '2.0', id: message.id, result: { turn } })
      emit({
        jsonrpc: '2.0',
        method: 'item/completed',
        params: { item: { id: `msg-${turns}`, type: 'agentMessage', text: 'ok' } },
      })
      emit({
        jsonrpc: '2.0',
        method: 'turn/completed',
        params: { turn: { status: 'completed', items: [] } },
      })
    })

    const client = new CodexClient()
    const signal = AbortSignal.timeout(4000)
    await client.start(transport, signal)
    expect(writes.find((frame) => frame.method === 'thread/start')?.params).toEqual({
      sandbox: 'workspace-write',
      approvalPolicy: 'on-request',
      developerInstructions: VAULT_CLI_RULES,
    })
    expect(client.turnId).toBe('')

    const resumed = new CodexClient()
    const resumeWrites: Array<Record<string, unknown>> = []
    const resumeTransport = scripted((message, emit) => {
      if (message.method == null) return
      resumeWrites.push(message)
      if (message.method === 'initialize') {
        emit({ jsonrpc: '2.0', id: message.id, result: {} })
        return
      }
      if (message.method === 'thread/resume') {
        emit({ jsonrpc: '2.0', id: message.id, result: { thread: { id: 'thread-9' } } })
      }
    })
    await resumed.start(resumeTransport, signal, { threadId: 'thread-9', cwd: '/vault' })
    expect(resumeWrites.find((frame) => frame.method === 'thread/resume')?.params).toEqual({
      threadId: 'thread-9',
      cwd: '/vault',
      sandbox: 'workspace-write',
      approvalPolicy: 'on-request',
      developerInstructions: VAULT_CLI_RULES,
    })
    expect(resumeWrites.some((frame) => frame.method === 'thread/start' || frame.method === 'session/load')).toBe(false)
    expect(JSON.stringify(resumeWrites)).not.toMatch(/"model"/)

    let text = ''
    await client.prompt('one', signal, (delta) => {
      text += delta
    })
    expect(text).toBe('ok')
    expect(client.turnId).toBe('turn-a')

    const activity: ExternalActivity[] = []
    await client.prompt('two', signal, () => undefined, (event) => {
      activity.push(event)
    })
    expect(client.turnId).toBe('turn-b')
    expect(activity).toContainEqual({
      id: '9004',
      name: 'permissions',
      phase: 'end',
      args: {},
      result: 'permissions request not auto-granted',
      isError: true,
    })
    expect(JSON.stringify(activity)).not.toContain('fileSystem')
    expect(JSON.stringify(activity)).not.toContain('network')
    expect(replies.find((frame) => frame.id === 9001)?.result).toEqual({ decision: 'accept' })
    expect(replies.some((frame) => frame.id === 9004)).toBe(false)
    expect(JSON.stringify(replies)).not.toContain('fileSystem')
    expect(JSON.stringify(replies)).not.toContain('network')

    await client.prompt('three', signal, () => undefined)
    expect(client.turnId).toBe('turn-b')
    expect(writes.filter((frame) => frame.method === 'thread/start')).toHaveLength(1)
    expect(writes.some((frame) => frame.method === 'thread/resume' || frame.method === 'session/set_model')).toBe(false)
  })

  it('still throws when the turn fails and the user did not stop', async () => {
    const transport = scripted((message, emit) => {
      if (message.method === 'initialize') {
        emit({ jsonrpc: '2.0', id: message.id, result: {} })
        return
      }
      if (message.method === 'initialized') return
      if (message.method === 'thread/start') {
        emit({ jsonrpc: '2.0', id: message.id, result: { thread: { id: 'thread-1' } } })
        return
      }
      if (message.method !== 'turn/start') return
      emit({ jsonrpc: '2.0', id: message.id, result: { turn: { id: 'turn-a', status: 'inProgress', items: [] } } })
      emit({
        jsonrpc: '2.0',
        method: 'turn/completed',
        params: { turn: { status: 'failed', error: { message: 'boom' } } },
      })
    })
    const client = new CodexClient()
    await client.start(transport, AbortSignal.timeout(4000))
    await expect(client.prompt('nope', AbortSignal.timeout(4000), () => undefined)).rejects.toThrow('external-agent-failed')
  })

  it('kills when the user stops before turn.id exists and does not invent an interrupt', async () => {
    const writes: string[] = []
    let kills = 0
    const transport = scripted((message, emit) => {
      writes.push(String(message.method ?? ''))
      if (message.method === 'initialize') {
        emit({ jsonrpc: '2.0', id: message.id, result: {} })
        return
      }
      if (message.method === 'initialized' || message.method === 'turn/start') return
      if (message.method === 'thread/start') {
        emit({ jsonrpc: '2.0', id: message.id, result: { thread: { id: 'thread-1' } } })
      }
    })
    const kill = transport.kill.bind(transport)
    transport.kill = () => {
      kills += 1
      return kill()
    }
    const client = new CodexClient()
    await client.start(transport, AbortSignal.timeout(4000))
    const controller = new AbortController()
    const pending = client.prompt('hang', controller.signal, () => undefined)
    controller.abort()
    await expect(pending).resolves.toEqual({ stopped: true, killed: true })
    expect(kills).toBe(1)
    expect(writes).not.toContain('turn/interrupt')
    expect(writes).not.toContain('thread/resume')
  })

  it('interrupts with this turn id and keeps the process when turn/completed arrives', async () => {
    const writes: Array<Record<string, unknown>> = []
    let kills = 0
    const transport = scripted((message, emit) => {
      if (message.method == null) return
      writes.push(message)
      if (message.method === 'initialize') {
        emit({ jsonrpc: '2.0', id: message.id, result: {} })
        return
      }
      if (message.method === 'initialized') return
      if (message.method === 'thread/start') {
        emit({ jsonrpc: '2.0', id: message.id, result: { thread: { id: 'thread-1' } } })
        return
      }
      if (message.method === 'turn/start') {
        emit({ jsonrpc: '2.0', id: message.id, result: { turn: { id: 'turn-a', status: 'inProgress', items: [] } } })
        return
      }
      if (message.method !== 'turn/interrupt') return
      emit({ jsonrpc: '2.0', id: message.id, result: {} })
      emit({
        jsonrpc: '2.0',
        method: 'turn/completed',
        params: { turn: { status: 'completed', items: [] } },
      })
    })
    const kill = transport.kill.bind(transport)
    transport.kill = () => {
      kills += 1
      return kill()
    }
    const client = new CodexClient()
    await client.start(transport, AbortSignal.timeout(4000))
    const controller = new AbortController()
    const pending = client.prompt('hang', controller.signal, () => undefined)
    await new Promise((resolve) => setTimeout(resolve, 0))
    controller.abort()
    await expect(pending).resolves.toEqual({ stopped: true, killed: false })
    expect(kills).toBe(0)
    expect(writes.find((frame) => frame.method === 'turn/interrupt')?.params).toEqual({
      threadId: 'thread-1',
      turnId: 'turn-a',
    })
  })

  it('kills when turn/interrupt is method not found', async () => {
    let kills = 0
    const writes: Array<Record<string, unknown>> = []
    const transport = scripted((message, emit) => {
      if (message.method === 'initialize') {
        emit({ jsonrpc: '2.0', id: message.id, result: {} })
        return
      }
      if (message.method === 'initialized') return
      if (message.method === 'thread/start') {
        emit({ jsonrpc: '2.0', id: message.id, result: { thread: { id: 'thread-1' } } })
        return
      }
      if (message.method === 'turn/start') {
        emit({ jsonrpc: '2.0', id: message.id, result: { turn: { id: 'turn-a', status: 'inProgress', items: [] } } })
        return
      }
      if (message.method !== 'turn/interrupt') return
      writes.push(message)
      emit({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } })
    })
    const kill = transport.kill.bind(transport)
    transport.kill = () => {
      kills += 1
      return kill()
    }
    const client = new CodexClient()
    await client.start(transport, AbortSignal.timeout(4000))
    const controller = new AbortController()
    const pending = client.prompt('hang', controller.signal, () => undefined)
    await new Promise((resolve) => setTimeout(resolve, 0))
    controller.abort()
    await expect(pending).resolves.toEqual({ stopped: true, killed: true })
    expect(writes.some((frame) => frame.method === 'turn/interrupt')).toBe(true)
    expect(kills).toBe(1)
  })
})
