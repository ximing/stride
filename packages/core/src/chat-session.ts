import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { AgentUsage } from './agent-loop.ts'
import { redactSecret } from './llm.ts'
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

export type ExternalCliMode = 'grok' | 'claude' | 'codex'

/** One CLI's resume handle. `cwd` is the vault root the handle was created in. */
export interface ExternalCliHandle {
  handle: string
  cwd: string
}

/** Per-mode slots. Switching CLI does not overwrite the others. */
export interface ChatExternalSlots {
  grok?: ExternalCliHandle
  claude?: ExternalCliHandle
  codex?: ExternalCliHandle
}

export interface ChatSessionFile {
  format: 1
  id: string
  messages: ChatSessionMessage[]
  /** Model transcript without system messages; the system prompt is rebuilt every turn. */
  transcript: AgentMessage[]
  memory: ChatSessionMemoryCursor
  /** Optional CLI handles. Absent on sessions written before resume existed. */
  external?: ChatExternalSlots
}

/** Claude `--resume` value: one argv element, same charset the main process allowlists. */
const CLAUDE_CLI_HANDLE = /^[A-Za-z0-9._:-]{1,128}$/
const JSON_HANDLE_MAX = 1024
const CWD_MAX = 4096

export const RESUME_PREFACE_PREFIX =
  'The previous CLI session could not be resumed. The following Stride chat is context, not the CLI\'s own memory.'

const PREFACE_MESSAGES = 8
const PREFACE_MESSAGE_CHARS = 500
const PREFACE_TOTAL_CHARS = 4000

export function isClaudeCliHandle(value: string): boolean {
  return CLAUDE_CLI_HANDLE.test(value)
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

function hasNul(value: string): boolean {
  return value.includes('\0')
}

function isAbsoluteSlotCwd(value: string): boolean {
  return value.startsWith('/') || value.startsWith('\\\\') || /^[A-Za-z]:[\\/]/.test(value)
}

function parseHandle(mode: ExternalCliMode, value: unknown): string | null {
  if (typeof value !== 'string' || value.length < 1 || hasNul(value)) return null
  if (mode === 'claude') return isClaudeCliHandle(value) ? value : null
  return value.length <= JSON_HANDLE_MAX ? value : null
}

function parseSlotCwd(value: unknown): string | null {
  if (typeof value !== 'string' || value.length < 1 || value.length > CWD_MAX || hasNul(value)) return null
  return isAbsoluteSlotCwd(value) ? value : null
}

/**
 * Keeps legal slots and lists modes whose slot was present but illegal.
 * An illegal slot does not reject the session file.
 */
export function parseExternalSlots(value: unknown): { external?: ChatExternalSlots; dropped: ExternalCliMode[] } {
  const dropped: ExternalCliMode[] = []
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { dropped }
  const raw = value as Record<string, unknown>
  const external: ChatExternalSlots = {}
  for (const mode of ['grok', 'claude', 'codex'] as const) {
    if (!Object.prototype.hasOwnProperty.call(raw, mode)) continue
    const slot = raw[mode]
    const record = slot && typeof slot === 'object' && !Array.isArray(slot) ? slot as { handle?: unknown; cwd?: unknown } : null
    const handle = record ? parseHandle(mode, record.handle) : null
    const cwd = record ? parseSlotCwd(record.cwd) : null
    if (!handle || !cwd) {
      dropped.push(mode)
      continue
    }
    external[mode] = { handle, cwd }
  }
  return { external: Object.keys(external).length > 0 ? external : undefined, dropped }
}

export function parseSession(text: string): ChatSessionFile | null {
  try {
    const raw = JSON.parse(text) as Partial<ChatSessionFile> | null
    if (!raw || typeof raw !== 'object' || raw.format !== 1) return null
    if (typeof raw.id !== 'string' || raw.id === '') return null
    const memory = (raw.memory && typeof raw.memory === 'object' ? raw.memory : {}) as Partial<ChatSessionMemoryCursor>
    const external = parseExternalSlots(raw.external).external
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
      ...(external ? { external } : {}),
    }
  } catch {
    return null
  }
}

export interface ResumePrefaceMessage {
  role: 'user' | 'assistant'
  text: string
  tools?: ReadonlyArray<{ name: string }>
}

function redactPreface(text: string, secrets: readonly string[]): string {
  let out = text
  for (const secret of secrets) out = redactSecret(out, secret)
  return out
}

/** Prior Stride turns shown to a fresh CLI. Not the CLI's own transcript. Newest messages win. */
export function buildResumePreface(messages: readonly ResumePrefaceMessage[], secrets: readonly string[]): string {
  const ordered = [...secrets].filter((secret) => secret !== '').sort((left, right) => right.length - left.length)
  const recent = messages
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .slice(-PREFACE_MESSAGES)
  const blocks: string[] = []
  for (const message of recent) {
    const text = redactPreface(message.text, ordered).slice(0, PREFACE_MESSAGE_CHARS)
    const names = (message.tools ?? [])
      .map((tool) => redactPreface(tool.name, ordered))
      .filter((name) => name !== '')
    if (!text && names.length === 0) continue
    const lines = [`${message.role}: ${text}`]
    if (names.length > 0) lines.push(`tools: ${names.join(', ')}`)
    blocks.push(lines.join('\n'))
  }
  while (blocks.length > 1 && blocks.join('\n\n').length > PREFACE_TOTAL_CHARS) blocks.shift()
  let body = blocks.join('\n\n')
  if (body.length > PREFACE_TOTAL_CHARS) body = body.slice(0, PREFACE_TOTAL_CHARS)
  return body ? `${RESUME_PREFACE_PREFIX}\n\n${body}` : RESUME_PREFACE_PREFIX
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
