import type { AgentProcessExit, AgentProcessTransport } from '@stride/platform'
import { ExternalAgentError } from './errors.ts'
import { createLineReader } from './lines.ts'

export interface RpcNote {
  method: string
  params: unknown
}

/** How a user-visible turn ended. `killed` means the cancel path already called `transport.kill` once. */
export interface ExternalTurnEnd {
  stopped: boolean
  killed: boolean
}

/** One external tool, command, or file row. The desktop caller redacts before display. */
export interface ExternalActivity {
  id: string
  name: string
  phase: 'start' | 'end'
  args: unknown
  result: string
  isError: boolean
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: ExternalAgentError) => void
}

/** JSON-RPC Request Cancelled. A successful user cancel, not a failed turn. */
export const RPC_CANCELLED = -32800

/** JSON-RPC Method not found. The cancel path kills the process when a cancel method returns this. */
export const RPC_METHOD_NOT_FOUND = -32601

export interface StartedCall {
  id: number
  done: Promise<unknown>
}

/** Newline-delimited JSON-RPC used by Codex app-server and Grok ACP. */
export class StdioRpc {
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private readonly listeners = new Set<(note: RpcNote) => void>()
  private activity: ((event: ExternalActivity) => void) | null = null
  private exitInfo: AgentProcessExit | null = null
  private readonly methodNotFound = new Set<() => void>()

  constructor(private readonly transport: AgentProcessTransport) {
    const push = createLineReader((line) => this.onLine(line))
    transport.onData(push)
    transport.onExit((info) => {
      this.exitInfo = info
      const error = this.closeError()
      for (const pending of this.pending.values()) pending.reject(error)
      this.pending.clear()
    })
  }

  onNotification(listener: (note: RpcNote) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Tool rows for server requests during the current turn. `null` still answers those requests. */
  setActivity(listener: ((event: ExternalActivity) => void) | null): void {
    this.activity = listener
  }

  /** Fires when a response carries JSON-RPC -32601, including an error with no request id. */
  onMethodNotFound(listener: () => void): () => void {
    this.methodNotFound.add(listener)
    return () => this.methodNotFound.delete(listener)
  }

  async notify(method: string, params?: unknown): Promise<void> {
    const body: Record<string, unknown> = { jsonrpc: '2.0', method }
    if (params !== undefined) body.params = params
    await this.transport.write(`${JSON.stringify(body)}\n`)
  }

  call(method: string, params: unknown, signal: AbortSignal): Promise<unknown> {
    return this.beginCall(method, params, signal, false).done
  }

  /**
   * `keepPendingOnAbort` leaves the id in `pending` when the user signal aborts.
   * A later -32800 must still be delivered to that id. Handshake calls do not use this.
   */
  beginCall(method: string, params: unknown, signal: AbortSignal, keepPendingOnAbort: boolean): StartedCall {
    if (!keepPendingOnAbort && signal.aborted) {
      return { id: 0, done: Promise.reject(new ExternalAgentError('abort', 'aborted')) }
    }
    if (this.exitInfo) return { id: 0, done: Promise.reject(this.closeError()) }
    const id = this.nextId
    this.nextId += 1
    const frame = `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`
    const done = new Promise((resolve, reject) => {
      let settled = false
      const finish = (settle: () => void) => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', onAbort)
        this.pending.delete(id)
        settle()
      }
      const onAbort = () => {
        if (keepPendingOnAbort) return
        finish(() => reject(new ExternalAgentError('abort', 'aborted')))
      }
      if (!signal.aborted) signal.addEventListener('abort', onAbort)
      this.pending.set(id, {
        resolve: (value) => finish(() => resolve(value)),
        reject: (error) => finish(() => reject(error)),
      })
      void this.transport.write(frame).catch((error: unknown) => {
        const pending = this.pending.get(id)
        pending?.reject(error instanceof ExternalAgentError ? error : new ExternalAgentError('failed', error instanceof Error ? error.message : 'write failed'))
      })
    })
    return { id, done }
  }

  private closeError(): ExternalAgentError {
    const detail = this.exitInfo?.error ?? 'process exited'
    if (/ENOENT|not found/i.test(detail)) return new ExternalAgentError('missing', detail)
    return new ExternalAgentError('failed', detail)
  }

  private onLine(line: string) {
    let message: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(line)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return
      message = parsed as Record<string, unknown>
    } catch {
      return
    }
    const method = typeof message.method === 'string' ? message.method : ''
    const id = rpcId(message.id)
    if (method && id !== null) {
      this.onServerRequest(id, method, message.params)
      return
    }
    if (method) {
      const note = { method, params: message.params }
      for (const listener of this.listeners) listener(note)
      return
    }
    const code = rpcErrorCode(message.error)
    if (code === RPC_METHOD_NOT_FOUND) {
      for (const listener of this.methodNotFound) listener()
    }
    if (typeof id !== 'number') return
    const pending = this.pending.get(id)
    if (!pending) return
    // -32800 is a successful cancel of this id. Rejecting it would tear the client down.
    if (code === RPC_CANCELLED) {
      pending.resolve({ stopReason: 'cancelled' })
      return
    }
    if (message.error && typeof message.error === 'object') {
      const rpcError = message.error as { message?: unknown }
      const detail = typeof rpcError.message === 'string' ? rpcError.message : 'rpc error'
      pending.reject(new ExternalAgentError('failed', detail, code ?? undefined))
      return
    }
    pending.resolve(message.result)
  }

  private reply(id: string | number, result: unknown) {
    void this.transport.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`).catch(() => undefined)
  }

  /**
   * Command, file, and elicitation approvals match the 0.167.2 result schemas.
   * `item/permissions/requestApproval` has no accept enum; an empty profile is not a confirmed deny.
   */
  private onServerRequest(id: string | number, method: string, params: unknown) {
    if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
      this.reply(id, { decision: 'accept' })
      return
    }
    if (method === 'mcpServer/elicitation/request') {
      this.reply(id, { action: 'accept', content: {} })
      return
    }
    if (method === 'item/permissions/requestApproval') {
      this.activity?.({
        id: String(id),
        name: 'permissions',
        phase: 'end',
        args: {},
        result: 'permissions request not auto-granted',
        isError: true,
      })
      return
    }
    this.reply(id, {})
    this.activity?.({
      id: String(id),
      name: method.slice(0, 60),
      phase: 'end',
      args: params ?? {},
      result: '',
      isError: false,
    })
  }
}

function rpcErrorCode(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null
  const code = (error as { code?: unknown }).code
  return typeof code === 'number' && Number.isFinite(code) ? code : null
}

function rpcId(value: unknown): string | number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.length > 0) return value
  return null
}
