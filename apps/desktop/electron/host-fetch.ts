import { decodeFileBytes, encodeFileBytes } from '@stride/electron-api'
import { assertTrustedSender, type RendererTrust, type TrustedSenderEvent } from './security.ts'
import { isAllowedFetchUrl } from './external-url.ts'

export interface FetchSender {
  getURL(): string
  send(channel: string, payload: unknown): void
  on(event: 'destroyed', listener: () => void): void
  removeListener(event: 'destroyed', listener: () => void): void
  isDestroyed(): boolean
}

export interface FetchIpcEvent {
  sender: FetchSender
}

export interface HostFetchDeps {
  handle(channel: string, listener: (event: FetchIpcEvent, payload?: unknown) => unknown): void
  getTrust(): RendererTrust
  /** Test seam. Production uses the Node/Electron global fetch. */
  fetch?: typeof fetch
}

interface FetchSession {
  controller: AbortController
  sender: FetchSender
  done: boolean
  onDestroyed: () => void
}

const CREDENTIAL_HEADERS = ['authorization', 'proxy-authorization', 'cookie', 'cookie2']
const BODY_HEADERS = [
  'content-encoding',
  'content-language',
  'content-length',
  'content-location',
  'content-type',
]

const MAX_BODY_BYTES = 32 * 1024 * 1024
const MAX_CHUNK_BYTES = 64 * 1024
const MAX_REDIRECTS = 5
const REQUEST_ID = /^[a-zA-Z0-9_-]{8,80}$/
const METHOD = /^[A-Za-z]{1,16}$/

const sessions = new Map<string, FetchSession>()

function record(payload: unknown): Record<string, unknown> {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error('Rejected invalid fetch request')
  }
  return payload as Record<string, unknown>
}

function requestIdOf(value: unknown): string {
  if (typeof value !== 'string' || !REQUEST_ID.test(value)) throw new Error('Rejected invalid fetch request')
  return value
}

function headersOf(value: unknown): Headers {
  const headers = new Headers()
  if (value == null) return headers
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('Rejected invalid fetch request')
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw !== 'string' || raw.includes('\n') || raw.includes('\r')) {
      throw new Error('Rejected invalid fetch request')
    }
    headers.set(key, raw)
  }
  return headers
}

function bytesAsBody(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(copy).set(bytes)
  return copy
}

function bodyOf(value: unknown): Uint8Array | undefined {
  if (value == null) return undefined
  const bytes = decodeFileBytes(value)
  if (bytes.byteLength > MAX_BODY_BYTES) throw new Error('Rejected invalid fetch request')
  return bytes
}

function emit(session: FetchSession, payload: unknown): void {
  if (session.sender.isDestroyed()) return
  session.sender.send('host:fetch:event', payload)
}

function release(session: FetchSession): void {
  session.sender.removeListener('destroyed', session.onDestroyed)
}

function finish(session: FetchSession, id: string): void {
  if (session.done) return
  session.done = true
  sessions.delete(id)
  release(session)
  emit(session, { requestId: id, type: 'end' })
}

function fail(session: FetchSession, id: string, message: string): void {
  if (session.done) return
  session.done = true
  sessions.delete(id)
  release(session)
  session.controller.abort()
  emit(session, { requestId: id, type: 'error', message })
}

function withoutHeaders(headers: Headers, names: readonly string[]): Headers {
  const next = new Headers(headers)
  for (const name of names) next.delete(name)
  return next
}

async function fetchChecked(
  fetchImpl: typeof fetch,
  url: string,
  method: string,
  headers: Headers,
  body: Uint8Array | undefined,
  signal: AbortSignal,
  hops: number,
): Promise<Response> {
  if (!isAllowedFetchUrl(url)) throw new Error('Rejected fetch URL')
  const response = await fetchImpl(url, {
    method,
    headers,
    body: body && method !== 'GET' && method !== 'HEAD' ? bytesAsBody(body) : undefined,
    redirect: 'manual',
    signal,
  })
  if (response.status < 300 || response.status >= 400) return response
  const location = response.headers.get('location')
  await response.body?.cancel().catch(() => {})
  if (!location || hops >= MAX_REDIRECTS) throw new Error('Rejected fetch URL')
  const next = new URL(location, url).toString()
  let nextHeaders = headers
  if (new URL(next).origin !== new URL(url).origin) {
    nextHeaders = withoutHeaders(nextHeaders, CREDENTIAL_HEADERS)
  }
  if (response.status === 301 || response.status === 302 || response.status === 303) {
    const dropBody = method !== 'GET' && method !== 'HEAD'
    return fetchChecked(
      fetchImpl,
      next,
      dropBody ? 'GET' : method,
      dropBody ? withoutHeaders(nextHeaders, BODY_HEADERS) : nextHeaders,
      dropBody ? undefined : body,
      signal,
      hops + 1,
    )
  }
  return fetchChecked(fetchImpl, next, method, nextHeaders, body, signal, hops + 1)
}

function pump(session: FetchSession, id: string, response: Response): void {
  void (async () => {
    try {
      const reader = response.body?.getReader()
      if (!reader) {
        finish(session, id)
        return
      }
      for (;;) {
        const step = await reader.read()
        if (session.done) return
        if (step.done) {
          finish(session, id)
          return
        }
        const value = step.value
        for (let offset = 0; offset < value.byteLength; offset += MAX_CHUNK_BYTES) {
          if (session.done) return
          const slice = value.subarray(offset, Math.min(offset + MAX_CHUNK_BYTES, value.byteLength))
          emit(session, { requestId: id, type: 'chunk', data: encodeFileBytes(slice) })
        }
      }
    } catch {
      // The fetch error text can include the URL. Keep it off the log and the wire.
      if (session.done) return
      fail(session, id, session.controller.signal.aborted ? 'aborted' : 'Network error')
    }
  })()
}

export function registerHostFetch(deps: HostFetchDeps): void {
  const fetchImpl = deps.fetch ?? fetch

  deps.handle('host:fetch', async (event, payload) => {
    assertTrustedSender(event as TrustedSenderEvent, deps.getTrust())
    const body = record(payload)
    const id = requestIdOf(body.requestId)
    if (sessions.has(id)) throw new Error('Rejected invalid fetch request')
    const url = body.url
    const method = body.method
    if (typeof url !== 'string' || !isAllowedFetchUrl(url)) throw new Error('Rejected fetch URL')
    if (typeof method !== 'string' || !METHOD.test(method)) throw new Error('Rejected invalid fetch request')
    const headers = headersOf(body.headers)
    const bytes = bodyOf(body.body)
    const controller = new AbortController()
    const session: FetchSession = {
      controller,
      sender: event.sender,
      done: false,
      onDestroyed: () => {},
    }
    session.onDestroyed = () => {
      if (session.done) return
      session.done = true
      sessions.delete(id)
      release(session)
      controller.abort()
    }
    sessions.set(id, session)
    event.sender.on('destroyed', session.onDestroyed)
    try {
      const response = await fetchChecked(fetchImpl, url, method.toUpperCase(), headers, bytes, controller.signal, 0)
      if (session.done) return { requestId: id, status: 499, statusText: 'aborted', headers: [] }
      const headersOut: [string, string][] = []
      response.headers.forEach((value, key) => {
        headersOut.push([key, value])
      })
      pump(session, id, response)
      return {
        requestId: id,
        status: response.status,
        statusText: response.statusText,
        headers: headersOut,
      }
    } catch {
      const aborted = controller.signal.aborted
      if (!session.done) fail(session, id, aborted ? 'aborted' : 'Network error')
      throw new Error(aborted ? 'aborted' : 'Network error')
    }
  })

  deps.handle('host:fetchAbort', (event, payload) => {
    assertTrustedSender(event as TrustedSenderEvent, deps.getTrust())
    const id = requestIdOf(record(payload).requestId)
    const session = sessions.get(id)
    if (!session || session.sender !== event.sender) return
    fail(session, id, 'aborted')
  })
}

/** Drop in-flight fetches. Does not log URLs, headers, or bodies. */
export function disposeHostFetches(): void {
  for (const [id, session] of [...sessions.entries()]) {
    fail(session, id, 'aborted')
  }
}
