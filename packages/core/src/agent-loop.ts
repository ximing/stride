import { Agent, type AgentTool, type StreamFn } from '@earendil-works/pi-agent-core'
import type { Api, AssistantMessage, Model } from '@earendil-works/pi-ai'
import { redactSecret } from './llm.ts'

export interface AgentUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  totalTokens: number
  costTotal: number
}

export type AgentLoopEvent =
  | { type: 'text_delta'; delta: string }
  | { type: 'thinking_delta'; delta: string }
  | { type: 'tool_start'; toolCallId: string; name: string; args: unknown }
  | { type: 'tool_end'; toolCallId: string; name: string; isError: boolean; durationMs: number; resultSummary: string }
  | { type: 'usage'; usage: AgentUsage }
  | { type: 'done'; text: string; usage: AgentUsage; aborted: boolean }

function emptyUsage(): AgentUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, costTotal: 0 }
}

function pieceUsage(message: AssistantMessage): AgentUsage {
  const usage = message.usage
  return {
    input: usage?.input ?? 0,
    output: usage?.output ?? 0,
    cacheRead: usage?.cacheRead ?? 0,
    cacheWrite: usage?.cacheWrite ?? 0,
    totalTokens: usage?.totalTokens || (usage?.input ?? 0) + (usage?.output ?? 0),
    costTotal: usage?.cost?.total ?? 0,
  }
}

function addUsage(total: AgentUsage, piece: AgentUsage): AgentUsage {
  return {
    input: total.input + piece.input,
    output: total.output + piece.output,
    cacheRead: total.cacheRead + piece.cacheRead,
    cacheWrite: total.cacheWrite + piece.cacheWrite,
    totalTokens: total.totalTokens + piece.totalTokens,
    costTotal: total.costTotal + piece.costTotal,
  }
}

function textOf(message: { content?: unknown } | undefined): string {
  if (!message || !Array.isArray(message.content)) return ''
  return message.content.map((part) => {
    if (!part || typeof part !== 'object') return ''
    const block = part as { type?: string; text?: string }
    return block.type === 'text' && typeof block.text === 'string' ? block.text : ''
  }).join('')
}

function summarize(value: unknown, secret: string): string {
  let text = ''
  if (typeof value === 'string') text = value
  else {
    try { text = JSON.stringify(value) } catch { text = '' }
  }
  return redactSecret(text, secret).slice(0, 200)
}

/** Provider failures resolve the prompt; they are not a normal end. Tool `isError` is not this. */
function providerErrorMessage(message: { role?: string; stopReason?: string; errorMessage?: string } | undefined): string | null {
  if (!message || message.role !== 'assistant' || message.stopReason !== 'error') return null
  return message.errorMessage?.trim() || 'Agent failed'
}

export async function runAgentLoop(input: {
  model: Model<Api>
  apiKey: string
  systemPrompt: string
  prompt: string
  tools?: AgentTool[]
  maxTurns?: number
  signal?: AbortSignal
  streamFn: StreamFn
  onEvent?: (event: AgentLoopEvent) => void
}): Promise<{ text: string; usage: AgentUsage; aborted: boolean }> {
  const maxTurns = input.maxTurns ?? 24
  let turns = 0
  let aborted = Boolean(input.signal?.aborted)
  let usage = emptyUsage()
  let deltas = ''
  const emit = (event: AgentLoopEvent) => { input.onEvent?.(event) }
  const agent = new Agent({
    streamFn: (model, context, options) => input.streamFn(model, context, { ...options, apiKey: input.apiKey }),
    getApiKey: () => input.apiKey,
    initialState: {
      systemPrompt: input.systemPrompt,
      model: input.model,
      tools: input.tools ?? [],
    },
    finishTurn: (turn) => {
      const reason = turn.message.stopReason
      if (reason === 'error' || reason === 'aborted') return
      turns += 1
      if (turns >= maxTurns) return { action: 'end' as const }
    },
    toolExecution: 'sequential',
  })
  const onAbort = () => {
    aborted = true
    agent.abort()
  }
  if (input.signal && !input.signal.aborted) input.signal.addEventListener('abort', onAbort, { once: true })
  if (aborted) agent.abort()
  agent.subscribe((event) => {
    if (event.type === 'message_update') {
      const inner = event.assistantMessageEvent
      if (inner.type === 'text_delta') {
        deltas += inner.delta
        emit({ type: 'text_delta', delta: inner.delta })
      } else if (inner.type === 'thinking_delta') {
        emit({ type: 'thinking_delta', delta: inner.delta })
      }
      return
    }
    if (event.type === 'tool_execution_start') {
      emit({ type: 'tool_start', toolCallId: event.toolCallId, name: event.toolName, args: event.args })
      return
    }
    if (event.type === 'tool_execution_end') {
      emit({
        type: 'tool_end',
        toolCallId: event.toolCallId,
        name: event.toolName,
        isError: event.isError,
        durationMs: event.durationMs ?? 0,
        resultSummary: summarize(event.result, input.apiKey),
      })
      return
    }
    if (event.type === 'message_end' && event.message.role === 'assistant') {
      const piece = pieceUsage(event.message)
      usage = addUsage(usage, piece)
      emit({ type: 'usage', usage: piece })
      if (event.message.stopReason === 'aborted') aborted = true
    }
  })
  try {
    if (!aborted) await agent.prompt(input.prompt)
  } catch (error) {
    if (!aborted && !input.signal?.aborted) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(redactSecret(message, input.apiKey))
    }
    aborted = true
  } finally {
    input.signal?.removeEventListener('abort', onAbort)
  }
  const last = [...agent.state.messages].reverse().find((message) => message.role === 'assistant')
  const failure = providerErrorMessage(last)
  if (failure && !aborted && input.signal?.aborted !== true) {
    throw new Error(redactSecret(failure, input.apiKey))
  }
  const text = deltas || textOf(last)
  const result = { text, usage, aborted: aborted || input.signal?.aborted === true }
  emit({ type: 'done', ...result })
  return result
}
