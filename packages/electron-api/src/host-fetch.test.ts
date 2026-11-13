import { afterEach, describe, expect, it, vi } from 'vitest'
import { ELECTRON_BRIDGE_KEY, encodeFileBytes } from './index.ts'
import { hostFetch } from './host-fetch.ts'

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[ELECTRON_BRIDGE_KEY]
})

describe('hostFetch helper', () => {
  it('returns status before the second chunk and aborts through the bridge', async () => {
    const events: Array<(payload: unknown) => void> = []
    const gate: { release: (() => void) | null } = { release: null }
    const invoke = vi.fn(async (channel: string, args?: { requestId?: string; body?: string; headers?: Record<string, string> }) => {
      if (channel === 'host:fetchAbort') return null
      const id = args?.requestId ?? ''
      events[0]?.({ requestId: id, type: 'chunk', data: encodeFileBytes(new TextEncoder().encode('one')) })
      void new Promise<void>((resolve) => {
        gate.release = () => {
          events[0]?.({ requestId: id, type: 'chunk', data: encodeFileBytes(new TextEncoder().encode('two')) })
          events[0]?.({ requestId: id, type: 'end' })
          resolve()
        }
      })
      return {
        requestId: id,
        status: 201,
        statusText: 'Created',
        headers: [['content-type', 'text/plain'], ['x-test', '1']],
      }
    })
    ;(globalThis as Record<string, unknown>)[ELECTRON_BRIDGE_KEY] = {
      invoke,
      on: (_channel: string, listener: (payload: unknown) => void) => {
        events.push(listener)
        return () => {
          const index = events.indexOf(listener)
          if (index >= 0) events.splice(index, 1)
        }
      },
    }

    const pending = hostFetch('http://127.0.0.1:9/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: new URLSearchParams({ q: '1' }),
    })
    const response = await pending
    expect(response.status).toBe(201)
    expect(response.headers.get('x-test')).toBe('1')
    const reader = response.body!.getReader()
    const first = await reader.read()
    expect(new TextDecoder().decode(first.value)).toBe('one')
    const early = reader.read()
    gate.release?.()
    const second = await early
    expect(new TextDecoder().decode(second.value)).toBe('two')
    expect((await reader.read()).done).toBe(true)

    const bodies = [
      'text',
      new Uint8Array([1, 2, 3]),
      new Uint8Array([4, 5]).buffer,
      new Blob(['blob']),
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([9]))
          controller.close()
        },
      }),
    ]
    for (const body of bodies) {
      const responsePromise = hostFetch('https://example.com/item', { method: 'PUT', body })
      gate.release = null
      const created = await responsePromise
      await created.body?.cancel()
    }
    const encoded = invoke.mock.calls
      .filter((call) => call[0] === 'host:fetch')
      .map((call) => (call[1] as { body?: string }).body)
    expect(encoded[0]).toBe(encodeFileBytes(new TextEncoder().encode('q=1')))
    expect(encoded[1]).toBe(encodeFileBytes(new TextEncoder().encode('text')))
    expect(encoded[2]).toBe(encodeFileBytes(new Uint8Array([1, 2, 3])))
    expect(encoded[3]).toBe(encodeFileBytes(new Uint8Array([4, 5])))
    expect(encoded[4]).toBe(encodeFileBytes(new TextEncoder().encode('blob')))
    expect(encoded[5]).toBe(encodeFileBytes(new Uint8Array([9])))

    const controller = new AbortController()
    const aborted = hostFetch('https://example.com/slow', { signal: controller.signal })
    controller.abort()
    await expect(aborted).rejects.toMatchObject({ name: 'AbortError' })
    expect(invoke.mock.calls.some((call) => call[0] === 'host:fetchAbort')).toBe(true)
  })
})
