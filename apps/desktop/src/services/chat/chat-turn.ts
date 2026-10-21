import type { AgentTool, StreamFn } from '@earendil-works/pi-agent-core'
import type { Api, Model } from '@earendil-works/pi-ai'
import { runAgentLoop } from '@stride/core'

export interface ChatToolCall {
  id: string
  name: string
  argsSummary: string
  resultSummary: string
  durationMs: number | null
  isError: boolean
  pending: boolean
}

export interface ChatMessage {
  role: 'user' | 'assistant'
  text: string
  thinking: string
  tools: ChatToolCall[]
}

export interface ChatSession {
  id: string
  title: string
  messages: ChatMessage[]
}

function lastAssistant(sessions: ChatSession[], sessionId: string): ChatMessage | null {
  const session = sessions.find((item) => item.id === sessionId)
  const message = session?.messages[session.messages.length - 1]
  if (!message || message.role !== 'assistant') return null
  if (!message.tools) message.tools = []
  return message
}

export function appendAssistantDelta(
  sessions: ChatSession[],
  sessionId: string,
  kind: 'text' | 'thinking',
  delta: string,
) {
  const message = lastAssistant(sessions, sessionId)
  if (!message) return
  if (kind === 'text') message.text += delta
  else message.thinking += delta
}

export function argsSummary(args: unknown): string {
  try {
    const text = JSON.stringify(args)
    return typeof text === 'string' ? text.slice(0, 120) : ''
  } catch {
    return ''
  }
}

export function appendToolStart(
  sessions: ChatSession[],
  sessionId: string,
  call: { id: string; name: string; args: unknown },
) {
  const message = lastAssistant(sessions, sessionId)
  if (!message) return
  message.tools.push({
    id: call.id,
    name: call.name,
    argsSummary: argsSummary(call.args),
    resultSummary: '',
    durationMs: null,
    isError: false,
    pending: true,
  })
}

export function appendToolEnd(
  sessions: ChatSession[],
  sessionId: string,
  call: { id: string; name: string; isError: boolean; durationMs: number; resultSummary: string },
) {
  const message = lastAssistant(sessions, sessionId)
  if (!message) return
  const summary = call.resultSummary.slice(0, 200)
  const existing = message.tools.find((tool) => tool.id === call.id)
  if (!existing) {
    message.tools.push({
      id: call.id,
      name: call.name,
      argsSummary: '',
      resultSummary: summary,
      durationMs: call.durationMs,
      isError: call.isError,
      pending: false,
    })
    return
  }
  existing.pending = false
  existing.isError = call.isError
  existing.durationMs = call.durationMs
  existing.resultSummary = summary
}

export async function playChatTurn(input: {
  model: Model<Api>
  apiKey: string
  systemPrompt: string
  prompt: string
  signal?: AbortSignal
  streamFn: StreamFn
  tools?: AgentTool[]
  onText: (delta: string) => void
  onThinking: (delta: string) => void
  onToolStart?: (call: { id: string; name: string; args: unknown }) => void
  onToolEnd?: (call: { id: string; name: string; isError: boolean; durationMs: number; resultSummary: string }) => void
}): Promise<{ text: string; aborted: boolean }> {
  return runAgentLoop({
    model: input.model,
    apiKey: input.apiKey,
    systemPrompt: input.systemPrompt,
    prompt: input.prompt,
    tools: input.tools ?? [],
    maxTurns: 8,
    signal: input.signal,
    streamFn: input.streamFn,
    onEvent: (event) => {
      if (event.type === 'text_delta') input.onText(event.delta)
      else if (event.type === 'thinking_delta') input.onThinking(event.delta)
      else if (event.type === 'tool_start') input.onToolStart?.({ id: event.toolCallId, name: event.name, args: event.args })
      else if (event.type === 'tool_end') {
        input.onToolEnd?.({
          id: event.toolCallId,
          name: event.name,
          isError: event.isError,
          durationMs: event.durationMs,
          resultSummary: event.resultSummary,
        })
      }
    },
  })
}
