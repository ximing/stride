import type { AgentProcessTransport } from '@stride/platform'
import { describe, expect, it } from 'vitest'
import { ExternalAgentError } from './errors.ts'
import { RPC_CANCELLED, RPC_METHOD_NOT_FOUND, StdioRpc } from './rpc.ts'

function rpcHarness() {
  let onData: ((chunk: string) => void) | null = null
  const writes: string[] = []
  const transport: AgentProcessTransport = {
    write(data) {
      writes.push(data)
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
      return Promise.resolve()
    },
  }
  return {
    writes,
    rpc: new StdioRpc(transport),
    emit(value: unknown) {
      onData?.(`${JSON.stringify(value)}\n`)
    },
  }
}

describe('StdioRpc cancel', () => {
  it('keeps the pending id on user abort so -32800 can resolve it', async () => {
    const { rpc, emit } = rpcHarness()
    const controller = new AbortController()
    const pending = rpc.beginCall('session/prompt', { sessionId: 's' }, controller.signal, true)
    let settled = false
    void pending.done.then(() => {
      settled = true
    }, () => {
      settled = true
    })
    controller.abort()
    await Promise.resolve()
    expect(settled).toBe(false)
    emit({
      jsonrpc: '2.0',
      id: pending.id,
      error: { code: RPC_CANCELLED, message: 'Request cancelled' },
    })
    await expect(pending.done).resolves.toEqual({ stopReason: 'cancelled' })
  })

  it('rejects a normal call on abort and then ignores a late -32800', async () => {
    const { rpc, emit } = rpcHarness()
    const controller = new AbortController()
    const pending = rpc.call('initialize', {}, controller.signal)
    const rejected = pending.then(() => 'resolved', (error: unknown) => error)
    controller.abort()
    await expect(rejected).resolves.toMatchObject({ failure: 'abort' })
    emit({
      jsonrpc: '2.0',
      id: 1,
      error: { code: RPC_CANCELLED, message: 'Request cancelled' },
    })
    await Promise.resolve()
    expect(await rejected).toBeInstanceOf(ExternalAgentError)
  })

  it('resolves a result whose stopReason is cancelled', async () => {
    const { rpc, emit } = rpcHarness()
    const pending = rpc.call('session/prompt', {}, new AbortController().signal)
    emit({ jsonrpc: '2.0', id: 1, result: { stopReason: 'cancelled' } })
    await expect(pending).resolves.toEqual({ stopReason: 'cancelled' })
  })

  it('reports method not found when the error has no id', async () => {
    const { rpc, emit } = rpcHarness()
    let found = 0
    rpc.onMethodNotFound(() => {
      found += 1
    })
    emit({ jsonrpc: '2.0', error: { code: RPC_METHOD_NOT_FOUND, message: 'Method not found' } })
    expect(found).toBe(1)
  })
})
