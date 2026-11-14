import { VAULT_CLI_RULES, type AgentProcessTransport } from '@stride/platform'
import { ExternalAgentError } from './errors.ts'
import { StdioRpc, type ExternalActivity, type ExternalTurnEnd } from './rpc.ts'

const HANDSHAKE_MS = 30_000
const CANCEL_MS = 5_000
const OUTPUT_TAIL = 2_000

/**
 * Grok ACP session: initialize, authenticate, session/new, then session/prompt.
 * Never calls session/set_model, so the CLI keeps its own default model.
 */
export class GrokClient {
  private rpc: StdioRpc | null = null
  private transport: AgentProcessTransport | null = null
  private sessionId = ''

  async start(transport: AgentProcessTransport, cwd: string, signal: AbortSignal): Promise<string> {
    const rpc = new StdioRpc(transport)
    this.rpc = rpc
    this.transport = transport
    const handshake = mergeSignal(signal, HANDSHAKE_MS)
    try {
      const initialized = await rpc.call('initialize', {
        protocolVersion: 1,
        clientInfo: { name: 'stride', version: 'dev' },
        clientCapabilities: {},
      }, handshake.signal)
      const methodId = authMethodId(initialized)
      if (methodId) {
        await rpc.call('authenticate', { methodId }, handshake.signal)
      }
      const created = await rpc.call('session/new', {
        cwd,
        mcpServers: [],
        _meta: { rules: VAULT_CLI_RULES },
      }, handshake.signal)
      const sessionId = sessionIdFrom(created)
      if (!sessionId) throw new ExternalAgentError('handshake', 'grok session id missing')
      this.sessionId = sessionId
      return sessionId
    } finally {
      handshake.cancel()
    }
  }

  async prompt(
    text: string,
    signal: AbortSignal,
    onText: (delta: string) => void,
    onActivity?: (event: ExternalActivity) => void,
  ): Promise<ExternalTurnEnd> {
    const rpc = this.rpc
    const transport = this.transport
    if (!rpc || !transport || !this.sessionId) throw new ExternalAgentError('failed', 'grok is not started')
    rpc.setActivity(onActivity ?? null)
    const names = new Map<string, string>()
    let unnamed = 0
    const stop = rpc.onNotification((note) => {
      if (note.method !== 'session/update') return
      const update = updateFrom(note.params)
      if (!update) return
      const kind = typeof update.sessionUpdate === 'string' ? update.sessionUpdate : ''
      if (kind === 'agent_thought_chunk' || kind === 'plan' || kind.startsWith('x.ai/')) return
      if (kind === 'tool_call' || kind === 'tool_call_update') {
        onActivity?.(toolActivity(update, kind === 'tool_call' ? 'start' : 'end', names, () => {
          unnamed += 1
          return unnamed
        }))
        return
      }
      const piece = acpChunk(note.params)
      if (piece) onText(piece)
    })
    // User abort must not reject this call or drop the id before -32800 arrives.
    const pending = rpc.beginCall('session/prompt', {
      sessionId: this.sessionId,
      prompt: [{ type: 'text', text }],
    }, signal, true)
    void pending.done.catch(() => undefined)
    let succeeded = false
    let killed = false
    let cancelStarted = false
    let budgetTimer: ReturnType<typeof setTimeout> | null = null
    let offNotFound: () => void = () => undefined
    let killTask: Promise<void> | null = null
    let closed = false
    let failCancel: (reason: 'timeout' | 'missing' | 'exit') => void = () => undefined
    const cancelFailed = new Promise<'timeout' | 'missing' | 'exit'>((resolve) => {
      failCancel = (reason) => resolve(reason)
    })
    const killOnce = (): Promise<void> => {
      if (succeeded) return Promise.resolve()
      if (!killTask) {
        killed = true
        if (budgetTimer) clearTimeout(budgetTimer)
        killTask = transport.kill().then(() => undefined, () => undefined)
      }
      return killTask
    }
    const onAbort = () => {
      if (cancelStarted || succeeded) return
      cancelStarted = true
      offNotFound = rpc.onMethodNotFound(() => failCancel('missing'))
      void (async () => {
        try {
          await rpc.notify('session/cancel', { sessionId: this.sessionId })
          await rpc.notify('$/cancel_request', { requestId: pending.id })
          if (closed || succeeded || killed) return
          budgetTimer = setTimeout(() => {
            if (succeeded || killed) return
            failCancel('timeout')
          }, CANCEL_MS)
        } catch {
          failCancel('timeout')
        }
      })()
    }
    const offExit = transport.onExit(() => failCancel('exit'))
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
    try {
      const outcome = await Promise.race([
        pending.done.then((value) => ({ ok: true as const, value })),
        cancelFailed.then((reason) => ({ ok: false as const, reason })),
      ])
      if (outcome.ok) {
        succeeded = true
        if (budgetTimer) clearTimeout(budgetTimer)
        return { stopped: signal.aborted, killed: false }
      }
      if (!signal.aborted) {
        const detail = outcome.reason === 'missing' ? 'method not found' : 'process exited'
        throw new ExternalAgentError('failed', detail, outcome.reason === 'missing' ? -32601 : undefined)
      }
      await killOnce()
      return { stopped: true, killed: true }
    } catch (error) {
      if (signal.aborted || killed) {
        await killOnce()
        return { stopped: true, killed: true }
      }
      throw error
    } finally {
      closed = true
      if (budgetTimer) clearTimeout(budgetTimer)
      offExit()
      offNotFound()
      stop()
      signal.removeEventListener('abort', onAbort)
      rpc.setActivity(null)
    }
  }
}

function authMethodId(value: unknown): string {
  if (!value || typeof value !== 'object') return ''
  const methods = (value as { authMethods?: unknown }).authMethods
  if (!Array.isArray(methods)) return ''
  const ids = methods.map((method) => {
    if (!method || typeof method !== 'object') return ''
    const id = (method as { id?: unknown }).id
    return typeof id === 'string' ? id : ''
  }).filter(Boolean)
  return ids.find((id) => id === 'xai-api-key') ?? ids[0] ?? ''
}

function sessionIdFrom(value: unknown): string {
  if (!value || typeof value !== 'object') return ''
  const id = (value as { sessionId?: unknown }).sessionId
  return typeof id === 'string' ? id : ''
}

function updateFrom(params: unknown): Record<string, unknown> | null {
  if (!params || typeof params !== 'object') return null
  const root = params as { update?: unknown }
  const update = root.update && typeof root.update === 'object' ? root.update : params
  if (!update || typeof update !== 'object' || Array.isArray(update)) return null
  return update as Record<string, unknown>
}

function acpChunk(params: unknown): string {
  const update = updateFrom(params)
  if (!update) return ''
  const kind = typeof update.sessionUpdate === 'string' ? update.sessionUpdate : ''
  if (kind && kind !== 'agent_message_chunk') return ''
  const content = update.content
  if (typeof content === 'string') return content
  if (!content || typeof content !== 'object' || Array.isArray(content)) return ''
  const text = (content as { text?: unknown }).text
  return typeof text === 'string' ? text : ''
}

function toolActivity(
  update: Record<string, unknown>,
  phase: 'start' | 'end',
  names: Map<string, string>,
  nextUnnamed: () => number,
): ExternalActivity {
  const storedId = typeof update.toolCallId === 'string' ? update.toolCallId : ''
  const fallback = storedId ? names.get(storedId) ?? '' : ''
  const name = toolName(update, fallback)
  const id = storedId || `${name}-${nextUnnamed()}`
  names.set(id, name)
  const failed = typeof update.status === 'string' && update.status.toLowerCase() === 'failed'
  return {
    id,
    name,
    phase,
    args: phase === 'start' ? toolArgs(update) : {},
    result: phase === 'end' ? outputTail(toolResult(update)) : '',
    isError: phase === 'end' && failed,
  }
}

function toolName(update: Record<string, unknown>, fallback: string): string {
  if (typeof update.title === 'string' && update.title) return update.title
  if (typeof update.kind === 'string' && update.kind) return update.kind
  return fallback || 'tool'
}

function toolArgs(update: Record<string, unknown>): unknown {
  if ('rawInput' in update && update.rawInput !== undefined) return update.rawInput
  if ('input' in update && update.input !== undefined) return update.input
  return {}
}

function toolResult(update: Record<string, unknown>): string {
  const parts: string[] = []
  if ('rawOutput' in update && update.rawOutput !== undefined) parts.push(textify(update.rawOutput))
  const content = contentText(update.content)
  if (content) parts.push(content)
  return parts.join('\n')
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((block) => {
      if (typeof block === 'string') return block
      if (!block || typeof block !== 'object') return ''
      const record = block as { text?: unknown; content?: unknown }
      if (typeof record.text === 'string') return record.text
      if (record.content && typeof record.content === 'object') {
        const nested = (record.content as { text?: unknown }).text
        if (typeof nested === 'string') return nested
      }
      return ''
    }).join('')
  }
  if (content && typeof content === 'object') {
    const text = (content as { text?: unknown }).text
    if (typeof text === 'string') return text
  }
  return ''
}

function textify(value: unknown): string {
  if (typeof value === 'string') return value
  if (value == null) return ''
  try {
    const encoded = JSON.stringify(value)
    return typeof encoded === 'string' ? encoded : ''
  } catch {
    return ''
  }
}

function outputTail(value: string): string {
  if (value.length <= OUTPUT_TAIL) return value
  return value.slice(value.length - OUTPUT_TAIL)
}

function mergeSignal(parent: AbortSignal, ms: number): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  const onAbort = () => controller.abort()
  if (parent.aborted) controller.abort()
  else parent.addEventListener('abort', onAbort, { once: true })
  return {
    signal: controller.signal,
    cancel() {
      clearTimeout(timer)
      parent.removeEventListener('abort', onAbort)
    },
  }
}
