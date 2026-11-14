import { VAULT_CLI_RULES, type AgentProcessTransport } from '@stride/platform'
import { ExternalAgentError } from './errors.ts'
import { RPC_METHOD_NOT_FOUND, StdioRpc, type ExternalActivity, type ExternalTurnEnd } from './rpc.ts'

const COMMAND_OUTPUT_TAIL = 2_000
const FILE_DIFF_LIMIT = 200

const HANDSHAKE_MS = 30_000
const CANCEL_MS = 5_000

/** Codex `app-server` session. The thread stays open for the next turn/start. */
export class CodexClient {
  private rpc: StdioRpc | null = null
  private transport: AgentProcessTransport | null = null
  private threadId = ''
  /** Latest `turn/start` id. Kept for a later interrupt; a response that omits it does not clear the previous one. */
  turnId = ''

  async start(
    transport: AgentProcessTransport,
    signal: AbortSignal,
    resume?: { threadId: string; cwd: string },
  ): Promise<string> {
    const rpc = new StdioRpc(transport)
    this.rpc = rpc
    this.transport = transport
    const handshake = mergeSignal(signal, HANDSHAKE_MS)
    try {
      await rpc.call('initialize', {
        clientInfo: { name: 'stride', version: 'dev' },
      }, handshake.signal)
      await rpc.notify('initialized')
      // Resume carries the same sandbox, approval policy, and rules. No model.
      const started = await rpc.call(resume ? 'thread/resume' : 'thread/start', resume ? {
        threadId: resume.threadId,
        cwd: resume.cwd,
        sandbox: 'workspace-write',
        approvalPolicy: 'on-request',
        developerInstructions: VAULT_CLI_RULES,
      } : {
        sandbox: 'workspace-write',
        approvalPolicy: 'on-request',
        developerInstructions: VAULT_CLI_RULES,
      }, handshake.signal)
      const threadId = threadIdFrom(started)
      if (!threadId) throw new ExternalAgentError('handshake', 'codex thread id missing')
      this.threadId = threadId
      return threadId
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
    if (!rpc || !transport || !this.threadId) throw new ExternalAgentError('failed', 'codex is not started')
    rpc.setActivity(onActivity ?? null)
    let streamed = false
    const seen = new Set<string>()
    const track: ItemTrack = { started: new Set<string>(), ended: new Set<string>() }
    let currentTurnId = ''
    let killed = false
    let succeeded = false
    let cancelSent = false
    let budgetTimer: ReturnType<typeof setTimeout> | null = null
    let killTask: Promise<void> | null = null
    let notifyKilled: () => void = () => undefined
    const killedNotice = new Promise<'killed'>((resolve) => {
      notifyKilled = () => resolve('killed')
    })
    const killOnce = (): Promise<void> => {
      if (succeeded) return Promise.resolve()
      if (!killTask) {
        killed = true
        notifyKilled()
        if (budgetTimer) clearTimeout(budgetTimer)
        killTask = transport.kill().then(() => undefined, () => undefined)
      }
      return killTask
    }
    const done = new Promise<{ status: string; error: string; items: unknown[] }>((resolve, reject) => {
      const stop = rpc.onNotification((note) => {
        if (note.method.startsWith('item/')) {
          if (note.method === 'item/agentMessage/delta' || note.method === 'item/started' || note.method === 'item/completed') {
            const piece = agentItemText(note.params, seen)
            if (piece) {
              streamed = true
              onText(piece)
            }
          }
          if (note.method === 'item/started' || note.method === 'item/completed') {
            const item = itemRecord(note.params)
            if (item) reportItem(item, note.method === 'item/started' ? 'started' : 'completed', track, onActivity)
          }
          return
        }
        if (note.method !== 'turn/completed') return
        stop()
        resolve(readTurn(note.params))
      })
      // Process exit settles the wait. The user abort must not.
      transport.onExit(() => {
        stop()
        reject(new ExternalAgentError('failed', 'process exited'))
      })
    })
    void done.catch(() => undefined)

    const onAbort = () => {
      if (cancelSent || killed || succeeded) return
      cancelSent = true
      if (!currentTurnId) {
        void killOnce()
        return
      }
      // `requestInterrupt` writes `turn/interrupt` before its first await. The 5s budget starts then.
      const interrupt = this.requestInterrupt(rpc, currentTurnId)
      budgetTimer = setTimeout(() => { void killOnce() }, CANCEL_MS)
      void interrupt.then((accepted) => {
        if (!accepted) void killOnce()
      })
    }
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })

    const idle = new AbortController()
    try {
      const started = rpc.call('turn/start', {
        threadId: this.threadId,
        input: [{ type: 'text', text }],
      }, idle.signal)
      void started.catch(() => undefined)
      const raced = await Promise.race([
        started.then((value) => ({ kind: 'started' as const, value })),
        killedNotice.then(() => ({ kind: 'killed' as const })),
      ])
      if (raced.kind === 'killed' || killed) {
        await killOnce()
        return { stopped: true, killed: true }
      }
      const turnId = turnIdFrom(raced.value)
      if (turnId) {
        this.turnId = turnId
        currentTurnId = turnId
      }
      if (signal.aborted && !currentTurnId) {
        await killOnce()
        return { stopped: true, killed: true }
      }
      if (signal.aborted) onAbort()
      const completed = await Promise.race([
        done,
        killedNotice.then(() => 'killed' as const),
      ])
      if (completed === 'killed' || killed) {
        await killOnce()
        return { stopped: true, killed: true }
      }
      // Set before item reporting so a throw after a clean cancel does not kill the live process.
      // A failed turn still rethrows: `succeeded` only swallows the error when the user aborted.
      succeeded = true
      if (budgetTimer) clearTimeout(budgetTimer)
      for (const item of completed.items) {
        if (item && typeof item === 'object' && !Array.isArray(item)) {
          reportItem(item as Record<string, unknown>, 'turn', track, onActivity)
        }
      }
      if (signal.aborted) return { stopped: true, killed: false }
      if (completed.status === 'failed') {
        throw new ExternalAgentError('failed', completed.error || 'codex turn failed')
      }
      if (!streamed) {
        for (const item of completed.items) {
          const piece = agentItemText({ item }, seen)
          if (piece) onText(piece)
        }
      }
      return { stopped: false, killed: false }
    } catch (error) {
      if (succeeded) {
        if (signal.aborted) return { stopped: true, killed: false }
        throw error
      }
      if (killed || signal.aborted) {
        await killOnce()
        return { stopped: true, killed: true }
      }
      throw error
    } finally {
      succeeded = succeeded || killed
      if (budgetTimer) clearTimeout(budgetTimer)
      signal.removeEventListener('abort', onAbort)
      rpc.setActivity(null)
    }
  }

  /** `turn/interrupt` takes only the two ids. Method-not-found is not a successful cancel. */
  private async requestInterrupt(rpc: StdioRpc, turnId: string): Promise<boolean> {
    try {
      await rpc.call('turn/interrupt', {
        threadId: this.threadId,
        turnId,
      }, new AbortController().signal)
      return true
    } catch (error) {
      if (error instanceof ExternalAgentError && error.rpcCode === RPC_METHOD_NOT_FOUND) return false
      if (error instanceof ExternalAgentError && /method not found/i.test(error.detail)) return false
      return false
    }
  }
}

interface ItemTrack {
  started: Set<string>
  ended: Set<string>
}

function turnIdFrom(value: unknown): string {
  if (!value || typeof value !== 'object') return ''
  const turn = (value as { turn?: unknown }).turn
  if (!turn || typeof turn !== 'object') return ''
  const id = (turn as { id?: unknown }).id
  return typeof id === 'string' ? id : ''
}

function threadIdFrom(value: unknown): string {
  if (!value || typeof value !== 'object') return ''
  const thread = (value as { thread?: unknown }).thread
  if (!thread || typeof thread !== 'object') return ''
  const id = (thread as { id?: unknown }).id
  return typeof id === 'string' ? id : ''
}

function readTurn(params: unknown): { status: string; error: string; items: unknown[] } {
  const turn = params && typeof params === 'object' ? (params as { turn?: unknown }).turn : null
  const record = turn && typeof turn === 'object' ? turn as { status?: unknown; error?: unknown; items?: unknown } : {}
  const error = record.error
  const message = typeof error === 'string'
    ? error
    : error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string'
      ? (error as { message: string }).message
      : ''
  return {
    status: typeof record.status === 'string' ? record.status : '',
    error: message,
    items: Array.isArray(record.items) ? record.items : [],
  }
}

function agentItemText(params: unknown, seen: Set<string>): string {
  if (!params || typeof params !== 'object') return ''
  const record = params as { item?: unknown; delta?: unknown; text?: unknown; id?: unknown }
  if (typeof record.delta === 'string' && record.delta) return record.delta
  const item = record.item && typeof record.item === 'object' ? record.item as Record<string, unknown> : record as Record<string, unknown>
  const id = typeof item.id === 'string' ? item.id : ''
  if (id && seen.has(id)) return ''
  const text = itemText(item)
  if (!text) return ''
  if (id) seen.add(id)
  return text
}

function itemRecord(params: unknown): Record<string, unknown> | null {
  if (!params || typeof params !== 'object') return null
  const item = (params as { item?: unknown }).item
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null
  return item as Record<string, unknown>
}

function reportItem(
  item: Record<string, unknown>,
  source: 'started' | 'completed' | 'turn',
  track: ItemTrack,
  onActivity?: (event: ExternalActivity) => void,
) {
  if (!onActivity) return
  const described = describeItem(item)
  if (!described) return
  const id = typeof item.id === 'string' && item.id ? item.id : described.name
  const status = typeof item.status === 'string' ? item.status : ''
  const phase = phaseFor(status, source)
  if (phase === 'start') {
    if (track.started.has(id) || track.ended.has(id)) return
    track.started.add(id)
    onActivity({ id, name: described.name, phase: 'start', args: described.args, result: '', isError: false })
    return
  }
  if (track.ended.has(id)) return
  track.ended.add(id)
  onActivity({
    id,
    name: described.name,
    phase: 'end',
    args: described.args,
    result: described.result,
    isError: described.isError,
  })
}

function phaseFor(status: string, source: 'started' | 'completed' | 'turn'): 'start' | 'end' {
  if (status === 'inProgress') return 'start'
  if (status === 'completed' || status === 'failed' || status === 'declined') return 'end'
  return source === 'started' ? 'start' : 'end'
}

function describeItem(item: Record<string, unknown>): { name: string; args: unknown; result: string; isError: boolean } | null {
  const type = typeof item.type === 'string' ? item.type : ''
  const status = typeof item.status === 'string' ? item.status : ''
  const failed = status === 'failed' || status === 'declined'
  if (type === 'commandExecution') {
    return { name: 'command', args: { command: text(item.command), cwd: text(item.cwd) }, result: commandResult(item), isError: failed }
  }
  if (type === 'fileChange') {
    const changes = fileChanges(item)
    return {
      name: 'file',
      args: changes.map((change) => ({ path: change.path, kind: change.kind })),
      result: fileResult(status, changes),
      isError: failed,
    }
  }
  if (type === 'mcpToolCall') {
    const server = text(item.server)
    const tool = text(item.tool)
    return {
      name: `mcp:${server}/${tool}`,
      args: item.arguments ?? {},
      result: mcpResult(item),
      isError: failed || (item.error != null),
    }
  }
  if (type === 'webSearch') {
    return {
      name: 'web_search',
      args: typeof item.query === 'string' && item.query ? item.query : {},
      result: status,
      isError: failed,
    }
  }
  return null
}

function commandResult(item: Record<string, unknown>): string {
  const parts: string[] = []
  if (typeof item.status === 'string' && item.status) parts.push(item.status)
  if (typeof item.exitCode === 'number') parts.push(`exitCode=${item.exitCode}`)
  if (typeof item.aggregatedOutput === 'string' && item.aggregatedOutput) parts.push(outputTail(item.aggregatedOutput))
  return parts.join('; ')
}

function fileChanges(item: Record<string, unknown>): Array<{ path: string; kind: string; diff: string }> {
  if (!Array.isArray(item.changes)) return []
  return item.changes.map((change) => {
    if (!change || typeof change !== 'object') return { path: '', kind: '', diff: '' }
    const record = change as Record<string, unknown>
    return {
      path: text(record.path),
      kind: changeKind(record.kind),
      diff: text(record.diff),
    }
  })
}

function fileResult(status: string, changes: Array<{ path: string; kind: string; diff: string }>): string {
  const parts: string[] = []
  if (status) parts.push(status)
  if (changes.some((change) => !change.path.endsWith('.stride.json'))) parts.push('undo unavailable')
  const diff = changes.map((change) => change.diff).filter(Boolean).join('\n').slice(0, FILE_DIFF_LIMIT)
  if (diff) parts.push(diff)
  return parts.join('; ')
}

function mcpResult(item: Record<string, unknown>): string {
  if (item.error != null) return textify(item.error)
  if (item.result != null) return textify(item.result)
  return typeof item.status === 'string' ? item.status : ''
}

function changeKind(kind: unknown): string {
  if (typeof kind === 'string') return kind
  if (kind && typeof kind === 'object' && typeof (kind as { type?: unknown }).type === 'string') {
    return (kind as { type: string }).type
  }
  return ''
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
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
  if (value.length <= COMMAND_OUTPUT_TAIL) return value
  return value.slice(value.length - COMMAND_OUTPUT_TAIL)
}

function itemText(item: Record<string, unknown>): string {
  if (item.type && item.type !== 'agentMessage' && item.type !== 'text') return ''
  if (typeof item.text === 'string') return item.text
  if (!Array.isArray(item.content)) return ''
  return item.content.map((block) => {
    if (!block || typeof block !== 'object') return ''
    const record = block as { type?: unknown; text?: unknown }
    return record.type === 'text' && typeof record.text === 'string' ? record.text : ''
  }).join('')
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
