// @vitest-environment node
import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { decodeFileBytes } from '@stride/electron-api'
import {
  installExternalWindowOpener,
  registerHostExternal,
  type HostExternalEvent,
} from './external-url.ts'
import { disposeHostFetches, registerHostFetch, type FetchIpcEvent, type FetchSender } from './host-fetch.ts'
import type { RendererTrust } from './security.ts'

const DEV = 'http://127.0.0.1:1421/'
const trust: RendererTrust = { packaged: false, devUrl: DEV }
const SECRET = 'super-secret-token'

interface Sent {
  channel: string
  payload: unknown
}

function createSender(url = DEV) {
  const destroyed: Array<() => void> = []
  let dead = false
  const sent: Sent[] = []
  const sender: FetchSender = {
    getURL: () => url,
    send(channel, payload) {
      sent.push({ channel, payload })
    },
    on(event, listener) {
      if (event === 'destroyed') destroyed.push(listener)
    },
    removeListener(event, listener) {
      if (event !== 'destroyed') return
      const index = destroyed.indexOf(listener)
      if (index >= 0) destroyed.splice(index, 1)
    },
    isDestroyed: () => dead,
  }
  return {
    sender,
    sent,
    listenerCount: () => destroyed.length,
    destroy() {
      dead = true
      for (const listener of [...destroyed]) listener()
    },
  }
}

function chunks(sent: Sent[]): string[] {
  return sent
    .map((event) => event.payload)
    .filter((payload): payload is { type: string; data?: string } => {
      return typeof payload === 'object' && payload !== null && (payload as { type?: string }).type === 'chunk'
    })
    .map((payload) => new TextDecoder().decode(decodeFileBytes(payload.data)))
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('missing port')
  return address.port
}

describe('host fetch and external links', () => {
  const servers: Server[] = []

  afterEach(async () => {
    disposeHostFetches()
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  })

  function setup() {
    const handlers = new Map<string, (event: FetchIpcEvent, payload?: unknown) => unknown>()
    registerHostFetch({
      handle: (channel, listener) => {
        handlers.set(channel, listener)
      },
      getTrust: () => trust,
    })
    const box = createSender()
    return {
      handlers,
      ...box,
      event: { sender: box.sender } as FetchIpcEvent,
    }
  }

  it('streams a loopback response that sends no CORS header, one chunk at a time', async () => {
    const gate: { release: (() => void) | null } = { release: null }
    const server = createServer((request, response) => {
      expect(request.headers['access-control-request-method']).toBeUndefined()
      response.writeHead(200, { 'Content-Type': 'text/plain', 'X-Body': 'visible' })
      response.flushHeaders()
      response.write('chunk1')
      void new Promise<void>((resolve) => {
        gate.release = () => {
          resolve()
        }
      }).then(() => {
        response.end('chunk2')
      })
    })
    servers.push(server)
    const port = await listen(server)
    const { handlers, sent, event } = setup()
    const head = await handlers.get('host:fetch')!(event, {
      requestId: 'req-stream-1',
      url: `http://127.0.0.1:${port}/sse`,
      method: 'GET',
      headers: { Authorization: SECRET },
    })
    expect(head).toMatchObject({ requestId: 'req-stream-1', status: 200, statusText: 'OK' })
    const listed = (head as { headers: [string, string][] }).headers
    expect(listed).toContainEqual(['content-type', 'text/plain'])
    expect(listed).toContainEqual(['x-body', 'visible'])
    expect(listed.some(([name]) => name === 'access-control-allow-origin')).toBe(false)
    await vi.waitFor(() => {
      expect(chunks(sent)).toEqual(['chunk1'])
    })
    expect(sent.some((item) => (item.payload as { type?: string }).type === 'end')).toBe(false)
    expect(JSON.stringify(sent)).not.toContain(SECRET)
    gate.release?.()
    await vi.waitFor(() => {
      expect(chunks(sent)).toEqual(['chunk1', 'chunk2'])
      expect(sent.at(-1)?.payload).toMatchObject({ type: 'end', requestId: 'req-stream-1' })
    })
  })

  it('keeps a non-2xx status and its headers', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(418, { 'X-Stride': 'kept' })
      response.end('nope')
    })
    servers.push(server)
    const port = await listen(server)
    const { handlers, sent, event } = setup()
    const head = await handlers.get('host:fetch')!(event, {
      requestId: 'req-status-1',
      url: `http://127.0.0.1:${port}/missing`,
      method: 'GET',
    })
    expect(head).toMatchObject({ status: 418 })
    expect((head as { headers: [string, string][] }).headers).toContainEqual(['x-stride', 'kept'])
    await vi.waitFor(() => {
      expect(chunks(sent)).toEqual(['nope'])
    })
  })

  it('aborts the local response and emits an abort error', async () => {
    let closed = false
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/plain' })
      response.write('partial')
      response.on('close', () => {
        closed = true
      })
    })
    servers.push(server)
    const port = await listen(server)
    const { handlers, sent, event } = setup()
    await handlers.get('host:fetch')!(event, {
      requestId: 'req-abort-01',
      url: `http://127.0.0.1:${port}/slow`,
      method: 'GET',
    })
    await vi.waitFor(() => {
      expect(chunks(sent)).toEqual(['partial'])
    })
    handlers.get('host:fetchAbort')!(event, { requestId: 'req-abort-01' })
    await vi.waitFor(() => {
      expect(sent.some((item) => (item.payload as { type?: string }).type === 'error')).toBe(true)
    })
    expect(sent.at(-1)?.payload).toMatchObject({ type: 'error', message: 'aborted', requestId: 'req-abort-01' })
    await vi.waitFor(() => {
      expect(closed).toBe(true)
    })
  })

  it('rejects public http without calling fetch', async () => {
    const fetchImpl = vi.fn()
    const handlers = new Map<string, (event: FetchIpcEvent, payload?: unknown) => unknown>()
    registerHostFetch({
      handle: (channel, listener) => {
        handlers.set(channel, listener)
      },
      getTrust: () => trust,
      fetch: fetchImpl as unknown as typeof fetch,
    })
    const box = createSender()
    await expect(handlers.get('host:fetch')!({ sender: box.sender }, {
      requestId: 'req-block-1',
      url: 'http://example.com/secret',
      method: 'GET',
      headers: { Authorization: SECRET },
    })).rejects.toThrow(/Rejected fetch URL/)
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(box.sent).toEqual([])
  })

  it('drops the session when the renderer goes away and does not log the request', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const server = createServer((_request, response) => {
      response.write('hold')
    })
    servers.push(server)
    const port = await listen(server)
    const { handlers, event, destroy, sent } = setup()
    await handlers.get('host:fetch')!(event, {
      requestId: 'req-destroy1',
      url: `http://localhost:${port}/hold`,
      method: 'POST',
      headers: { Authorization: SECRET },
      body: Buffer.from('body-secret').toString('base64'),
    })
    destroy()
    handlers.get('host:fetchAbort')!(event, { requestId: 'req-destroy1' })
    expect(sent.some((item) => JSON.stringify(item).includes(SECRET))).toBe(false)
    expect(error.mock.calls.flat().join(' ')).not.toContain(SECRET)
    expect(log.mock.calls.flat().join(' ')).not.toContain('body-secret')
    error.mockRestore()
    log.mockRestore()
  })

  it('strips credentials and body headers on a cross-origin 302', async () => {
    const seen: Array<{ url: string; method: string; headers: [string, string][] }> = []
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      seen.push({
        url: String(input),
        method: String(init?.method),
        headers: [...headers.entries()],
      })
      if (seen.length === 1) {
        return new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/next' } })
      }
      return new Response('landed', { status: 200 })
    })
    const handlers = new Map<string, (event: FetchIpcEvent, payload?: unknown) => unknown>()
    registerHostFetch({
      handle: (channel, listener) => {
        handlers.set(channel, listener)
      },
      getTrust: () => trust,
      fetch: fetchImpl as unknown as typeof fetch,
    })
    const box = createSender()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const head = await handlers.get('host:fetch')!({ sender: box.sender }, {
      requestId: 'req-redir-01',
      url: 'http://127.0.0.1:9/start',
      method: 'POST',
      headers: {
        Authorization: SECRET,
        Cookie: 'sid=secret',
        Cookie2: 'legacy-secret',
        'Proxy-Authorization': 'Basic secret',
        'Content-Type': 'application/json',
        'Content-Length': '4',
        'Content-Encoding': 'gzip',
        'X-Keep': 'yes',
      },
      body: Buffer.from('body').toString('base64'),
    })
    expect(head).toMatchObject({ status: 200 })
    expect(seen).toHaveLength(2)
    expect(seen[0]?.headers).toEqual(expect.arrayContaining([['authorization', SECRET]]))
    const second = seen[1]!
    expect(second.method).toBe('GET')
    const names = second.headers.map(([name]) => name)
    expect(names).not.toEqual(expect.arrayContaining([
      'authorization',
      'proxy-authorization',
      'cookie',
      'cookie2',
      'content-type',
      'content-length',
      'content-encoding',
    ]))
    expect(second.headers).toContainEqual(['x-keep', 'yes'])
    expect(JSON.stringify(seen[1])).not.toContain(SECRET)
    expect(JSON.stringify(box.sent)).not.toContain(SECRET)
    expect(error.mock.calls.flat().join(' ')).not.toContain(SECRET)
    expect(log.mock.calls.flat().join(' ')).not.toContain('127.0.0.1')
    error.mockRestore()
    log.mockRestore()
    await vi.waitFor(() => {
      expect(box.sent.at(-1)?.payload).toMatchObject({ type: 'end' })
    })
    expect(box.listenerCount()).toBe(0)
  })

  it('rejects a redirect onto public http and does not call fetch again', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { location: 'http://example.com/steal' },
    }))
    const handlers = new Map<string, (event: FetchIpcEvent, payload?: unknown) => unknown>()
    registerHostFetch({
      handle: (channel, listener) => {
        handlers.set(channel, listener)
      },
      getTrust: () => trust,
      fetch: fetchImpl as unknown as typeof fetch,
    })
    const box = createSender()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await expect(handlers.get('host:fetch')!({ sender: box.sender }, {
      requestId: 'req-redir-02',
      url: 'https://127.0.0.1/start',
      method: 'GET',
      headers: { Authorization: SECRET },
    })).rejects.toThrow(/^Network error$/)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(box.sent)).not.toContain(SECRET)
    expect(JSON.stringify(box.sent)).not.toContain('example.com')
    expect(error.mock.calls.flat().join(' ')).not.toContain('example.com')
    expect(log.mock.calls.flat().join(' ')).not.toContain(SECRET)
    error.mockRestore()
    log.mockRestore()
    expect(box.listenerCount()).toBe(0)
  })

  it('dispose ends an open stream with one abort error and drops the listener', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/plain' })
      response.write('partial')
    })
    servers.push(server)
    const port = await listen(server)
    const { handlers, sent, event, listenerCount } = setup()
    const url = `http://127.0.0.1:${port}/hold`
    await handlers.get('host:fetch')!(event, {
      requestId: 'req-dispose1',
      url,
      method: 'GET',
    })
    await vi.waitFor(() => {
      expect(chunks(sent)).toEqual(['partial'])
    })
    expect(listenerCount()).toBe(1)
    disposeHostFetches()
    const errors = sent.filter((item) => (item.payload as { type?: string }).type === 'error')
    expect(errors).toEqual([{
      channel: 'host:fetch:event',
      payload: { requestId: 'req-dispose1', type: 'error', message: 'aborted' },
    }])
    expect(JSON.stringify(sent)).not.toContain(url)
    expect(listenerCount()).toBe(0)
    disposeHostFetches()
    expect(sent.filter((item) => (item.payload as { type?: string }).type === 'error')).toHaveLength(1)
  })

  it('opens only http(s) from window.open and from host:openExternal', async () => {
    const opened: string[] = []
    const handlers: Array<(details: { url: string }) => { action: string }> = []
    const window = {
      destroyed: false,
      isDestroyed: () => window.destroyed,
      webContents: {
        setWindowOpenHandler(handler: (details: { url: string }) => { action: string }) {
          handlers.push(handler)
        },
      },
    }
    installExternalWindowOpener(window, async (url) => {
      opened.push(url)
    })
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    await Promise.resolve()
    const handler = handlers.at(-1)
    expect(handler).toBeTypeOf('function')
    expect(handler!({ url: 'https://example.com/release' })).toEqual({ action: 'deny' })
    expect(handler!({ url: 'http://127.0.0.1:9/local' })).toEqual({ action: 'deny' })
    expect(handler!({ url: 'file:///etc/passwd' })).toEqual({ action: 'deny' })
    expect(handler!({ url: 'stride://vault' })).toEqual({ action: 'deny' })
    await Promise.resolve()
    expect(opened).toEqual(['https://example.com/release', 'http://127.0.0.1:9/local'])

    const ipc = new Map<string, (event: HostExternalEvent, payload?: unknown) => unknown>()
    const exit = vi.fn()
    const relaunch = vi.fn()
    registerHostExternal({
      handle: (channel, listener) => {
        ipc.set(channel, listener)
      },
      getTrust: () => trust,
      openExternal: async (url) => {
        opened.push(`ipc:${url}`)
      },
      exit,
      relaunch,
    })
    const event = { sender: { getURL: () => DEV } }
    await ipc.get('host:openExternal')!(event, { url: 'https://github.com/ximing/stride' })
    await expect(ipc.get('host:openExternal')!(event, { url: 'file:///tmp/x' })).rejects.toThrow(/Rejected external URL/)
    ipc.get('app:relaunch')!(event)
    expect(relaunch).toHaveBeenCalledOnce()
    expect(exit).toHaveBeenLastCalledWith(0)
    ipc.get('app:exit')!(event)
    expect(exit).toHaveBeenLastCalledWith(0)
    expect(opened).toContain('ipc:https://github.com/ximing/stride')
  })
})
