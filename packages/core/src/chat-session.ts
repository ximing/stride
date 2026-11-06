import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { AgentUsage } from './agent-loop.ts'
import { sha256HexSync } from './sha256.ts'

/** Tool-call summary kept in the persisted UI projection (same fields as the panel's ChatToolCall). */
export interface ChatSessionToolCall {
  id: string
  name: string
  argsSummary: string
  resultSummary: string
  durationMs: number | null
  isError: boolean
  pending: boolean
}

/** UI projection message: rendered directly, never replayed to the model. */
export interface ChatSessionMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  thinking: string
  ts: string
  tools: ChatSessionToolCall[]
}

export interface ChatSessionMeta {
  format: 1
  id: string
  vaultKey: string
  vaultLabel: string
  title: string
  createdAt: string
  updatedAt: string
  status: 'active' | 'closed'
  modelId: string
  messageCount: number
  usage: AgentUsage
}

/**
 * Distillation cursor. `distilledUpTo` counts transcript entries; any future
 * transcript compression resets it and forces a full re-distill.
 */
export interface ChatSessionMemoryCursor {
  distilledUpTo: number
  lastDistillAt: string
}

export interface ChatSessionFile {
  format: 1
  id: string
  messages: ChatSessionMessage[]
  /** Model transcript without system messages; the system prompt is rebuilt every turn. */
  transcript: AgentMessage[]
  memory: ChatSessionMemoryCursor
}

export const TRUNCATED_MARK = '[truncated]'
export const TOOL_RESULT_MAX_CHARS = 8192
const TITLE_MAX_CHARS = 24

export function newSessionId(): string {
  return `ses_${globalThis.crypto.randomUUID()}`
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0
}

function normalizeUsage(value: unknown): AgentUsage {
  const raw = value && typeof value === 'object' ? value as Partial<AgentUsage> : {}
  return {
    input: count(raw.input),
    output: count(raw.output),
    cacheRead: count(raw.cacheRead),
    cacheWrite: count(raw.cacheWrite),
    totalTokens: count(raw.totalTokens),
    costTotal: typeof raw.costTotal === 'number' && Number.isFinite(raw.costTotal) ? raw.costTotal : 0,
  }
}

function normalizeTool(value: unknown): ChatSessionToolCall | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Partial<ChatSessionToolCall>
  return {
    id: str(raw.id),
    name: str(raw.name),
    argsSummary: str(raw.argsSummary),
    resultSummary: str(raw.resultSummary),
    durationMs: typeof raw.durationMs === 'number' && Number.isFinite(raw.durationMs) ? raw.durationMs : null,
    isError: raw.isError === true,
    pending: raw.pending === true,
  }
}

function normalizeMessage(value: unknown): ChatSessionMessage | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Partial<ChatSessionMessage>
  if (raw.role !== 'user' && raw.role !== 'assistant') return null
  return {
    id: str(raw.id),
    role: raw.role,
    text: str(raw.text),
    thinking: str(raw.thinking),
    ts: str(raw.ts),
    tools: Array.isArray(raw.tools)
      ? raw.tools.map(normalizeTool).filter((tool): tool is ChatSessionToolCall => tool !== null)
      : [],
  }
}

export function serializeSessionMeta(meta: ChatSessionMeta): string {
  return JSON.stringify(meta)
}

export function parseSessionMeta(text: string): ChatSessionMeta | null {
  try {
    const raw = JSON.parse(text) as Partial<ChatSessionMeta> | null
    if (!raw || typeof raw !== 'object' || raw.format !== 1) return null
    if (typeof raw.id !== 'string' || raw.id === '') return null
    return {
      format: 1,
      id: raw.id,
      vaultKey: str(raw.vaultKey),
      vaultLabel: str(raw.vaultLabel),
      title: str(raw.title),
      createdAt: str(raw.createdAt),
      updatedAt: str(raw.updatedAt),
      status: raw.status === 'closed' ? 'closed' : 'active',
      modelId: str(raw.modelId),
      messageCount: count(raw.messageCount),
      usage: normalizeUsage(raw.usage),
    }
  } catch {
    return null
  }
}

export function serializeSession(file: ChatSessionFile): string {
  return JSON.stringify(file)
}

export function parseSession(text: string): ChatSessionFile | null {
  try {
    const raw = JSON.parse(text) as Partial<ChatSessionFile> | null
    if (!raw || typeof raw !== 'object' || raw.format !== 1) return null
    if (typeof raw.id !== 'string' || raw.id === '') return null
    const memory = (raw.memory && typeof raw.memory === 'object' ? raw.memory : {}) as Partial<ChatSessionMemoryCursor>
    return {
      format: 1,
      id: raw.id,
      messages: Array.isArray(raw.messages)
        ? raw.messages.map(normalizeMessage).filter((message): message is ChatSessionMessage => message !== null)
        : [],
      // Stored transcripts never carry system messages; strip defensively on read too.
      transcript: stripSystemMessages(Array.isArray(raw.transcript) ? raw.transcript : []),
      memory: {
        distilledUpTo: count(memory.distilledUpTo),
        lastDistillAt: str(memory.lastDistillAt),
      },
    }
  } catch {
    return null
  }
}

/** System messages are rebuilt per turn; they must never enter a persisted transcript or history seed. */
export function stripSystemMessages(messages: AgentMessage[]): AgentMessage[] {
  return messages.filter((message) => message?.role !== 'system')
}

/** Caps individual tool-result text parts so session files cannot grow without bound. */
export function truncateTranscript(messages: AgentMessage[], maxToolResultChars = TOOL_RESULT_MAX_CHARS): AgentMessage[] {
  return messages.map((message) => {
    if (message?.role !== 'toolResult' || !Array.isArray(message.content)) return message
    let changed = false
    const content = message.content.map((part) => {
      if (!part || part.type !== 'text' || typeof part.text !== 'string') return part
      if (part.text.length <= maxToolResultChars) return part
      changed = true
      return { ...part, text: `${part.text.slice(0, maxToolResultChars)}\n${TRUNCATED_MARK}` }
    })
    return changed ? { ...message, content } : message
  })
}

/** Session title from the first user message; mirrors the in-memory panel behavior. */
export function sessionTitleFromText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX_CHARS)
}

const keyEncoder = new TextEncoder()

/** Per-vault storage directory key: first 16 hex chars of the vault id's SHA-256. */
export function vaultStorageKey(vaultId: string): string {
  return sha256HexSync(keyEncoder.encode(vaultId)).slice(0, 16)
}
