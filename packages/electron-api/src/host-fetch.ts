import { electronBridge, type ElectronBridge, type ElectronDisposer } from './index.ts'
import { decodeFileBytes, encodeFileBytes } from './fs.ts'

/** `host:fetch` body. `body` is base64 when the caller sent bytes. */
export interface HostFetchRequest {
  requestId: string
  url: string
  method: string
  headers: Record<string, string>
  body?: string
}

/** Returned before any body bytes. `headers` keeps duplicate names. */
export interface HostFetchHead {
  requestId: string
  status: number
  statusText: string
  headers: [string, string][]
}

/** One `host:fetch:event` payload. `chunk.data` is base64. */
export type HostFetchEvent =
  | { requestId: string; type: 'chunk'; data: string }
  | { requestId: string; type: 'end' }
  | { requestId: string; type: 'error'; message: string }

function bridge(): ElectronBridge {
  return electronBridge()
}

function abortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError')
}

function requestId(): string {
  const bytes = new Uint8Array(16)
  globalThis.crypto.getRandomValues(bytes)
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function headerRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {}
  headers.forEach((value, key) => {
    record[key] = value
  })
  return record
}

async function bytesOf(body: BodyInit): Promise<Uint8Array> {
  if (typeof body === 'string') return new TextEncoder().encode(body)
  if (body instanceof URLSearchParams) return new TextEncoder().encode(body.toString())
  if (body instanceof Uint8Array) return new Uint8Array(body)
  if (body instanceof ArrayBuffer) return new Uint8Array(body)
  if (ArrayBuffer.isView(body)) {
    return new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
  }
  if (typeof Blob !== 'undefined' && body instanceof Blob) {
    return new Uint8Array(await body.arrayBuffer())
  }
  if (typeof body === 'object' && body !== null && typeof (body as ReadableStream<Uint8Array>).getReader === 'function') {
    const reader = (body as ReadableStream<Uint8Array>).getReader()
    const parts: Uint8Array[] = []
    let total = 0
    for (;;) {
      const step = await reader.read()
      if (step.done) break
      const value = step.value instanceof Uint8Array ? step.value : new Uint8Array(step.value)
      parts.push(value)
      total += value.byteLength
    }
    const merged = new Uint8Array(total)
    let offset = 0
    for (const part of parts) {
      merged.set(part, offset)
      offset += part.byteLength
    }
    return merged
  }
  throw new Error('Rejected unsupported fetch body')
}

function isHostFetchEvent(value: unknown): value is HostFetchEvent {
  if (typeof value !== 'object' || value === null) return false
  const record = value as { requestId?: unknown; type?: unknown }
  return typeof record.requestId === 'string' && (record.type === 'chunk' || record.type === 'end' || record.type === 'error')
}

function isHostFetchHead(value: unknown): value is HostFetchHead {
  if (typeof value !== 'object' || value === null) return false
  const record = value as HostFetchHead
  return typeof record.requestId === 'string'
    && typeof record.status === 'number'
    && typeof record.statusText === 'string'
    && Array.isArray(record.headers)
}

/**
 * Native desktop fetch. Headers return before the body, and each chunk is a
 * `host:fetch:event`. A request `ReadableStream` is read up front; the response is not.
 */
export async function hostFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const source = typeof Request !== 'undefined' && input instanceof Request ? input : null
  const signal = init?.signal ?? source?.signal
  if (signal?.aborted) throw abortError()

  const url = source ? source.url : input instanceof URL ? input.toString() : String(input)
  const method = (init?.method ?? source?.method ?? 'GET').toUpperCase()
  const headers = new Headers(init?.headers ?? source?.headers)
  let bytes: Uint8Array | undefined
  if (init && init.body != null) bytes = await bytesOf(init.body)
  else if (source && source.body) bytes = new Uint8Array(await source.arrayBuffer())

  const id = requestId()
  const ipc = bridge()
  const queued: HostFetchEvent[] = []
  let stream: ReadableStreamDefaultController<Uint8Array> | null = null
  let dispose: ElectronDisposer = () => {}
  let settled = false

  function cleanup(): void {
    if (settled) return
    settled = true
    dispose()
    signal?.removeEventListener('abort', abortRemote)
  }

  function apply(event: HostFetchEvent): void {
    if (event.type === 'chunk') {
      const chunk = decodeFileBytes(event.data)
      if (stream) stream.enqueue(chunk)
      else queued.push(event)
      return
    }
    if (!stream) {
      queued.push(event)
      return
    }
    if (event.type === 'end') stream.close()
    else stream.error(event.message === 'aborted' ? abortError() : new Error(event.message || 'Network error'))
    cleanup()
  }

  dispose = ipc.on('host:fetch:event', (payload) => {
    if (!isHostFetchEvent(payload) || payload.requestId !== id) return
    apply(payload)
  })

  function abortRemote(): void {
    void ipc.invoke('host:fetchAbort', { requestId: id }).catch(() => {})
  }

  signal?.addEventListener('abort', abortRemote, { once: true })

  const request: HostFetchRequest = {
    requestId: id,
    url,
    method,
    headers: headerRecord(headers),
  }
  if (bytes && bytes.byteLength > 0) request.body = encodeFileBytes(bytes)

  try {
    const head: unknown = await ipc.invoke('host:fetch', request)
    if (signal?.aborted) {
      abortRemote()
      cleanup()
      throw abortError()
    }
    if (!isHostFetchHead(head) || head.requestId !== id) {
      cleanup()
      throw new Error('Rejected invalid fetch response')
    }
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        stream = controller
        for (const event of queued.splice(0)) apply(event)
      },
      cancel() {
        abortRemote()
        cleanup()
      },
    })
    return new Response(body, {
      status: head.status,
      statusText: head.statusText,
      headers: head.headers,
    })
  } catch (error) {
    cleanup()
    throw error
  }
}
