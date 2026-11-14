import type { AgentMessage, AgentTool, StreamFn } from '@earendil-works/pi-agent-core'
import type { Api, Model } from '@earendil-works/pi-ai'
import {
  AGENT_MAX_TURNS_DEFAULT,
  normalizeAgentMaxTurns,
  runAgentLoop,
  type AgentUsage,
  type ChatExternalSlots,
  type ExternalCliMode,
} from '@stride/core'

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
  /** Stable id and creation time, assigned when the message is appended; persisted with the session. */
  id?: string
  ts?: string
}

export interface ChatSessionMemory {
  distilledUpTo: number
  lastDistillAt: string
}

export interface ChatSession {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  status: 'active' | 'closed'
  /** Locked to the model of the first completed assistant turn; empty follows the composer. */
  modelId: string
  messages: ChatMessage[]
  /** Transcript without system messages, maintained in memory for continuation and persistence. */
  transcript: AgentMessage[]
  memory: ChatSessionMemory
  usage: AgentUsage
  /** CLI resume handles. Same shape as the session file. Absent when no mode has a slot. */
  external?: ChatExternalSlots
  /** Modes whose stored slot was illegal and dropped on read. Not written back. */
  externalDropped?: ExternalCliMode[]
}

export function emptyChatUsage(): AgentUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, costTotal: 0 }
}

export function newChatMessageId(): string {
  return `msg_${globalThis.crypto.randomUUID()}`
}

/** A fresh in-memory session. Blank sessions are never persisted. */
export function blankChatSession(id: string, title = 'New'): ChatSession {
  const now = new Date().toISOString()
  return {
    id,
    title,
    createdAt: now,
    updatedAt: now,
    status: 'active',
    modelId: '',
    messages: [],
    transcript: [],
    memory: { distilledUpTo: 0, lastDistillAt: '' },
    usage: emptyChatUsage(),
  }
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

/** Provider failure surfaced like the loop used to throw, but with the transcript attached for persistence. */
export class ChatTurnError extends Error {
  readonly transcript: AgentMessage[]
  constructor(message: string, transcript: AgentMessage[]) {
    super(message)
    this.name = 'ChatTurnError'
    this.transcript = transcript
  }
}

export interface ChatTurnResult {
  text: string
  usage: AgentUsage
  aborted: boolean
  turnLimit: boolean
  transcript: AgentMessage[]
}

export async function playChatTurn(input: {
  model: Model<Api>
  apiKey: string
  systemPrompt: string
  prompt: string
  /** Prior transcript without system messages, for multi-turn continuation. */
  history?: AgentMessage[]
  signal?: AbortSignal
  streamFn: StreamFn
  tools?: AgentTool[]
  /** Model rounds for this message. Missing or invalid values use the default. */
  maxTurns?: number
  onText: (delta: string) => void
  onThinking: (delta: string) => void
  onToolStart?: (call: { id: string; name: string; args: unknown }) => void
  onToolEnd?: (call: { id: string; name: string; isError: boolean; durationMs: number; resultSummary: string }) => void
  onUsage?: (usage: AgentUsage) => void
}): Promise<ChatTurnResult> {
  const result = await runAgentLoop({
    model: input.model,
    apiKey: input.apiKey,
    systemPrompt: input.systemPrompt,
    prompt: input.prompt,
    history: input.history,
    tools: input.tools ?? [],
    maxTurns: normalizeAgentMaxTurns(input.maxTurns ?? AGENT_MAX_TURNS_DEFAULT),
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
      } else if (event.type === 'usage') input.onUsage?.(event.usage)
    },
  })
  if (result.error) throw new ChatTurnError(result.error, result.transcript)
  return result
}
