import type { AgentProcessTransport } from '@stride/platform'
import { ExternalAgentError } from './errors.ts'
import { createLineReader, LineQueue, parseJsonLine, remainingMs } from './lines.ts'
import type { ExternalActivity, ExternalTurnEnd } from './rpc.ts'

const HANDSHAKE_MS = 30_000
const TURN_MS = 10 * 60_000
const CANCEL_MS = 5_000

/** Claude Code stream-json session. Stdin stays open for the next user frame. */
export class ClaudeClient {
  private transport: AgentProcessTransport | null = null
  private readonly queue = new LineQueue()
  private readonly toolNames = new Map<string, string>()
  private onActivity: ((event: ExternalActivity) => void) | null = null

  start(transport: AgentProcessTransport, signal: AbortSignal): Promise<string> {
    this.transport = transport
    const push = createLineReader((line) => this.ingest(line))
    transport.onData(push)
    transport.onExit((info) => this.queue.close(info))
    return this.waitForInit(signal)
  }

  async prompt(
    text: string,
    signal: AbortSignal,
    onText: (delta: string) => void,
    onActivity?: (event: ExternalActivity) => void,
  ): Promise<ExternalTurnEnd> {
    const transport = this.transport
    if (!transport) throw new ExternalAgentError('failed', 'claude is not started')
    this.onActivity = onActivity ?? null
    let cancelRequested = false
    let budgetHit = false
    let killed = false
    let ended = false
    let budgetTimer: ReturnType<typeof setTimeout> | null = null
    let activeWait: AbortController | null = null

    const killOnce = async (): Promise<ExternalTurnEnd> => {
      if (!killed) {
        killed = true
        budgetHit = true
        await transport.kill().catch(() => undefined)
      }
      return { stopped: true, killed: true }
    }

    // The user signal must not reject the read. A 5s timer aborts only the current wait.
    const onAbort = () => {
      if (cancelRequested) return
      cancelRequested = true
      const frame = {
        type: 'control_request',
        request_id: controlRequestId(),
        request: { subtype: 'interrupt' },
      }
      // The 5s budget starts when the interrupt frame is written, not when the user clicks stop.
      void transport.write(`${JSON.stringify(frame)}\n`).then(() => {
        if (ended || killed) return
        budgetTimer = setTimeout(() => {
          if (ended || killed) return
          budgetHit = true
          activeWait?.abort()
        }, CANCEL_MS)
      }, () => {
        if (ended || killed) return
        budgetHit = true
        activeWait?.abort()
      })
    }
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })

    try {
      await transport.write(`${JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text }] },
      })}\n`)
      const deadline = Date.now() + TURN_MS
      let streamed = false
      for (;;) {
        if (budgetHit) return killOnce()
        activeWait = new AbortController()
        let line: string
        try {
          line = await this.queue.next(activeWait.signal, remainingMs(deadline), 'failed')
        } catch (error) {
          if (cancelRequested || budgetHit) return killOnce()
          throw error
        }
        const frame = parseJsonLine(line)
        // control_response means the interrupt was accepted. The turn ends only on result.
        if (frame?.type === 'result') {
          ended = true
          if (budgetTimer) clearTimeout(budgetTimer)
          if (cancelRequested) return { stopped: true, killed: false }
          if (frame.is_error === true) throw new ExternalAgentError('failed', resultDetail(frame))
          if (!streamed && typeof frame.result === 'string' && frame.result) onText(frame.result)
          return { stopped: false, killed: false }
        }
        if (budgetHit) return killOnce()
        if (!frame || frame.type === 'stream_event' || frame.type === 'control_response') continue
        if (frame.type === 'assistant') {
          this.recordToolUses(frame.message)
          const piece = textFromContent(frame.message)
          if (piece) {
            streamed = true
            onText(piece)
          }
          continue
        }
        if (frame.type === 'user') this.recordToolResults(frame.message)
      }
    } catch (error) {
      if (cancelRequested || budgetHit || killed) return killOnce()
      throw error
    } finally {
      ended = true
      if (budgetTimer) clearTimeout(budgetTimer)
      signal.removeEventListener('abort', onAbort)
      this.onActivity = null
    }
  }

  private ingest(line: string) {
    const frame = parseJsonLine(line)
    if (!frame) return
    if (frame.type === 'control_request') {
      const transport = this.transport
      if (!transport) return
      void transport.write(`${JSON.stringify(controlResponse(frame))}\n`).catch(() => undefined)
      this.recordControl(frame)
      return
    }
    this.queue.push(line)
  }

  private async waitForInit(signal: AbortSignal): Promise<string> {
    const deadline = Date.now() + HANDSHAKE_MS
    while (!signal.aborted) {
      const line = await this.queue.next(signal, remainingMs(deadline), 'handshake')
      const frame = parseJsonLine(line)
      if (!frame || frame.type !== 'system') continue
      if (typeof frame.session_id === 'string' && frame.session_id) return frame.session_id
    }
    throw new ExternalAgentError('abort', 'aborted')
  }

  private emit(event: ExternalActivity) {
    this.onActivity?.(event)
  }

  private recordControl(frame: Record<string, unknown>) {
    const request = frame.request && typeof frame.request === 'object'
      ? frame.request as Record<string, unknown>
      : {}
    const toolName = typeof request.tool_name === 'string' ? request.tool_name : ''
    const subtype = typeof request.subtype === 'string' ? request.subtype : ''
    const name = toolName || subtype || 'control'
    const id = typeof frame.request_id === 'string' && frame.request_id ? frame.request_id : name
    const args = request.input ?? {}
    this.emit({ id, name, phase: 'start', args, result: '', isError: false })
    this.emit({ id, name, phase: 'end', args, result: 'allow', isError: false })
  }

  private recordToolUses(message: unknown) {
    for (const block of contentBlocks(message)) {
      if (block.type !== 'tool_use') continue
      const name = typeof block.name === 'string' && block.name ? block.name : 'tool'
      const id = typeof block.id === 'string' && block.id ? block.id : name
      this.toolNames.set(id, name)
      this.emit({
        id,
        name,
        phase: 'start',
        args: block.input ?? {},
        result: '',
        isError: false,
      })
    }
  }

  private recordToolResults(message: unknown) {
    for (const block of contentBlocks(message)) {
      if (block.type !== 'tool_result') continue
      const id = typeof block.tool_use_id === 'string' && block.tool_use_id ? block.tool_use_id : 'tool'
      const named = typeof block.name === 'string' && block.name ? block.name : ''
      this.emit({
        id,
        name: this.toolNames.get(id) || named || 'tool',
        phase: 'end',
        args: {},
        result: blockText(block.content),
        isError: block.is_error === true,
      })
    }
  }
}

function contentBlocks(message: unknown): Array<Record<string, unknown>> {
  if (!message || typeof message !== 'object') return []
  const content = (message as { content?: unknown }).content
  if (!Array.isArray(content)) return []
  return content.filter((block): block is Record<string, unknown> => !!block && typeof block === 'object' && !Array.isArray(block))
}

function textFromContent(message: unknown): string {
  if (!message || typeof message !== 'object') return ''
  const content = (message as { content?: unknown }).content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((block) => {
    if (!block || typeof block !== 'object') return ''
    const record = block as { type?: unknown; text?: unknown }
    return record.type === 'text' && typeof record.text === 'string' ? record.text : ''
  }).join('')
}

function blockText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((block) => {
      if (typeof block === 'string') return block
      if (!block || typeof block !== 'object') return ''
      const record = block as { type?: unknown; text?: unknown; content?: unknown }
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

function controlRequestId(): string {
  const bytes = new Uint8Array(16)
  globalThis.crypto.getRandomValues(bytes)
  let hex = ''
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0')
  return hex
}

function resultDetail(frame: Record<string, unknown>): string {
  if (typeof frame.result === 'string' && frame.result) return frame.result
  return 'claude result error'
}

function controlResponse(frame: Record<string, unknown>): Record<string, unknown> {
  const request = frame.request && typeof frame.request === 'object'
    ? frame.request as { input?: unknown }
    : {}
  const requestId = typeof frame.request_id === 'string' ? frame.request_id : ''
  return {
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: requestId,
      response: {
        behavior: 'allow',
        updatedInput: request.input ?? {},
      },
    },
  }
}
