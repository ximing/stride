/**
 * Long-term memory model: a two-level store per scope (project / global).
 * Level one is `index.json` (titles + one-line summaries, injected into the
 * system prompt), level two is `entries/<id>.json` (full content, fetched on
 * demand via memory_read). Pure functions only; all I/O lives in the host.
 */

import type { AgentMessage } from '@earendil-works/pi-agent-core'

export type MemoryKind = 'preference' | 'fact' | 'decision' | 'context' | 'correction'
export type MemoryScope = 'project' | 'global'
export type MemoryStatus = 'active' | 'archived'

export const MEMORY_KINDS: readonly MemoryKind[] = ['preference', 'fact', 'decision', 'context', 'correction']

export interface MemoryIndexEntry {
  id: string
  kind: MemoryKind
  title: string
  summary: string
  tags: string[]
  status: MemoryStatus
  updatedAt: string
  sessionId: string
  supersedes: string[]
}

export interface MemoryIndex {
  format: 1
  updatedAt: string
  distillCount: number
  entries: MemoryIndexEntry[]
}

export interface MemoryEntry {
  format: 1
  id: string
  kind: MemoryKind
  title: string
  content: string
  tags: string[]
  createdAt: string
  updatedAt: string
  source: { sessionId: string; noteIds: string[] }
  status: MemoryStatus
}

export function newMemoryId(): string {
  return `mem_${globalThis.crypto.randomUUID()}`
}

export function emptyMemoryIndex(updatedAt = ''): MemoryIndex {
  return { format: 1, updatedAt, distillCount: 0, entries: [] }
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function strList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0
}

function kind(value: unknown): MemoryKind {
  return (MEMORY_KINDS as readonly string[]).includes(str(value)) ? value as MemoryKind : 'fact'
}

function status(value: unknown): MemoryStatus {
  return value === 'archived' ? 'archived' : 'active'
}

function normalizeIndexEntry(value: unknown): MemoryIndexEntry | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Partial<MemoryIndexEntry>
  if (typeof raw.id !== 'string' || raw.id === '') return null
  return {
    id: raw.id,
    kind: kind(raw.kind),
    title: str(raw.title),
    summary: str(raw.summary),
    tags: strList(raw.tags),
    status: status(raw.status),
    updatedAt: str(raw.updatedAt),
    sessionId: str(raw.sessionId),
    supersedes: strList(raw.supersedes),
  }
}

export function serializeMemoryIndex(index: MemoryIndex): string {
  return JSON.stringify(index)
}

export function parseMemoryIndex(text: string): MemoryIndex | null {
  try {
    const raw = JSON.parse(text) as Partial<MemoryIndex> | null
    if (!raw || typeof raw !== 'object' || raw.format !== 1) return null
    return {
      format: 1,
      updatedAt: str(raw.updatedAt),
      distillCount: count(raw.distillCount),
      entries: Array.isArray(raw.entries)
        ? raw.entries.map(normalizeIndexEntry).filter((entry): entry is MemoryIndexEntry => entry !== null)
        : [],
    }
  } catch {
    return null
  }
}

export function serializeMemoryEntry(entry: MemoryEntry): string {
  return JSON.stringify(entry)
}

export function parseMemoryEntry(text: string): MemoryEntry | null {
  try {
    const raw = JSON.parse(text) as Partial<MemoryEntry> | null
    if (!raw || typeof raw !== 'object' || raw.format !== 1) return null
    if (typeof raw.id !== 'string' || raw.id === '') return null
    const source = (raw.source && typeof raw.source === 'object' ? raw.source : {}) as Partial<MemoryEntry['source']>
    return {
      format: 1,
      id: raw.id,
      kind: kind(raw.kind),
      title: str(raw.title),
      content: str(raw.content),
      tags: strList(raw.tags),
      createdAt: str(raw.createdAt),
      updatedAt: str(raw.updatedAt),
      source: { sessionId: str(source.sessionId), noteIds: strList(source.noteIds) },
      status: status(raw.status),
    }
  } catch {
    return null
  }
}

/** Same-id overwrite; bumps the index updatedAt to the entry's, keeps distillCount. */
export function upsertIndexEntry(index: MemoryIndex, entry: MemoryIndexEntry): MemoryIndex {
  const entries = index.entries.some((item) => item.id === entry.id)
    ? index.entries.map((item) => (item.id === entry.id ? entry : item))
    : [...index.entries, entry]
  return { ...index, updatedAt: entry.updatedAt, entries }
}

/** One-line index summary derived from entry content: first non-empty line, capped. */
export function summarizeMemoryContent(content: string, maxChars = 120): string {
  const line = content.split('\n').map((item) => item.trim()).find((item) => item !== '') ?? ''
  return line.replace(/\s+/g, ' ').slice(0, maxChars)
}

/** Injection budgets (characters) for the memory index section of the system prompt. */
export const PROJECT_MEMORY_BUDGET = 2048
export const GLOBAL_MEMORY_BUDGET = 1024

function indexLine(entry: MemoryIndexEntry): string {
  return `- [${entry.kind}] ${entry.title} — ${entry.summary} (${entry.id})`
}

function scopeLines(entries: MemoryIndexEntry[], budget: number): string[] {
  const sorted = entries
    .filter((entry) => entry.status === 'active')
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  const lines: string[] = []
  let used = 0
  let omitted = 0
  for (const entry of sorted) {
    const line = indexLine(entry)
    if (used + line.length + 1 > budget) {
      omitted += 1
      continue
    }
    used += line.length + 1
    lines.push(line)
  }
  if (omitted > 0) lines.push(`- … ${omitted} more entries; call memory_read with an id to retrieve details.`)
  return lines
}

/**
 * Markdown section injected between the vault snapshot and the assistant
 * prompt. Project scope first, global second; '' when there is nothing to say.
 */
export function buildMemorySection(input: { project: MemoryIndex | null; global: MemoryIndex | null }): string {
  const project = scopeLines(input.project?.entries ?? [], PROJECT_MEMORY_BUDGET)
  const globalScope = scopeLines(input.global?.entries ?? [], GLOBAL_MEMORY_BUDGET)
  if (project.length === 0 && globalScope.length === 0) return ''
  const parts = ['## Long-term memory index']
  if (project.length > 0) parts.push('', '### Project memory (this vault)', ...project)
  if (globalScope.length > 0) parts.push('', '### Global memory (all vaults)', ...globalScope)
  return parts.join('\n')
}

/** Contains-semantics secret scan over every configured key; empty keys never match. */
export function containsConfiguredSecret(text: string, secrets: string[]): boolean {
  return secrets.some((secret) => secret !== '' && text.includes(secret))
}

export const MEMORY_LOG_MAX_LINES = 1000

/** Log rotation: beyond the cap, keep the newest half. */
export function rotateLogLines(lines: string[]): string[] {
  if (lines.length <= MEMORY_LOG_MAX_LINES) return lines
  return lines.slice(-Math.floor(MEMORY_LOG_MAX_LINES / 2))
}

export const VAULT_MEMORY_PROMPT = [
  'You have a long-term memory index (shown above when memories exist). Each entry has an id and a one-line summary.',
  'When an entry looks relevant to the current task and you need its details, call memory_read with the entry id.',
  'Call memory_write sparingly: only for corrections the user gave you, durable user preferences, project conventions, or important decisions with their reasons. Never record one-off task context, anything the vault itself already records, transient state, or your own guesses about the user — memory needs the user’s words or explicit confirmation. When in doubt, do not write.',
  'To update an existing entry on the same topic, pass its id instead of creating a new one.',
  'Project-scope memory wins over global-scope memory when they conflict. Prefer project scope unless the memory applies to every vault.',
  'Never write secrets into memory: no API keys, tokens, or passwords.',
].join('\n')

/** Curation triggers (design §6.2): every Nth distillation, or an active-entry count past the scope limit. */
export const CURATE_DISTILL_INTERVAL = 10
export const CURATE_PROJECT_ENTRY_LIMIT = 100
export const CURATE_GLOBAL_ENTRY_LIMIT = 50

export function shouldCurate(scope: MemoryScope, index: MemoryIndex | null): boolean {
  if (!index) return false
  if (index.distillCount > 0 && index.distillCount % CURATE_DISTILL_INTERVAL === 0) return true
  const active = index.entries.filter((entry) => entry.status === 'active').length
  return active > (scope === 'project' ? CURATE_PROJECT_ENTRY_LIMIT : CURATE_GLOBAL_ENTRY_LIMIT)
}

/**
 * Transcript increment for distillation: entries from `from` onward, minus any
 * trailing aborted assistant messages — a stopped half-turn must not reach
 * long-term memory (design §6.1).
 */
export function distillableSlice(transcript: AgentMessage[], from: number): AgentMessage[] {
  const slice = transcript.slice(Math.max(0, Math.floor(from)))
  let end = slice.length
  while (end > 0) {
    const message = slice[end - 1] as { role?: string; stopReason?: string } | undefined
    if (message?.role === 'assistant' && message.stopReason === 'aborted') end -= 1
    else break
  }
  return slice.slice(0, end)
}

/**
 * System prompt for the headless distillation pass (design §6.1). Static
 * English by convention, like VAULT_ASSISTANT_PROMPT — prompts never go
 * through i18n.
 */
export const DISTILL_MEMORY_PROMPT = [
  'You are extracting durable long-term memory from a finished chat session.',
  'You are given the not-yet-distilled portion of the session transcript as the user message, and the current memory indexes below when memories exist.',
  '',
  'The bar is high: most sessions should produce NO memory at all. Before writing any entry, ask: "If the assistant did not know this in a future session, would it repeat a mistake or choose a wrong default?" Only a clear yes qualifies.',
  '',
  'Worth remembering:',
  '- Corrections: the user told the assistant its approach was wrong and how to do it right.',
  '- Durable preferences: stable, cross-task instructions the user stated (language, style, workflow, tooling choices).',
  '- Project conventions: vault-level rules the user stated or confirmed (formats, required fields, commit or review rules).',
  '- Decisions: important choices the user made, with the reason, that shape future work.',
  '',
  'Never worth remembering:',
  '- One-off task context: what was asked or done in this session (edits, fixes, queries). It is process, not knowledge.',
  '- Anything the vault itself already records: note content, metadata, structure, or anything a search of the vault would answer. The vault is the source of truth; memory must not duplicate it.',
  '- Small talk, single questions, pleasantries.',
  '- The assistant’s own guesses or inferences about the user. Memory needs the user’s words or explicit confirmation.',
  '- Transient state: what the user is doing right now, current drafts, temporary blockers.',
  '',
  'To update an existing entry on the same topic, call memory_write with that entry id instead of creating a new one.',
  'Choose the scope deliberately: project scope for rules of this vault, global scope only for preferences that apply to every vault.',
  'Never store secrets: no API keys, tokens, or passwords.',
  'Act only through the memory tools; no free-text reply. If nothing clears the bar — the common case — call no tools at all.',
].join('\n')

/** System prompt for the headless curation pass (design §6.2). */
export const CURATE_MEMORY_PROMPT = [
  'You are maintaining a long-term memory store. The user message carries the full memory indexes for the project and global scopes.',
  'Call memory_read to inspect an entry before changing it, then apply these rules using only the memory tools:',
  '1. Conflicts: when two entries contradict each other on the same topic, keep the one with the newer updatedAt and archive the older with memory_forget.',
  '2. Stale: archive entries that reference notes or files that no longer exist, or that a later decision clearly superseded.',
  '3. Corrupt: fix or archive entries with empty content, broken structure, or duplicate ids.',
  '4. Merge: when several fragments describe the same fact, merge them into one entry with memory_write and archive the fragments with memory_forget.',
  '5. Low value: archive entries that restate vault content, capture one-off task context, record the assistant’s unconfirmed guesses, or describe transient state. Memory holds durable preferences, conventions, decisions, and corrections only — anything below that bar does not belong.',
  'Act only through the memory tools; no free-text reply. If the store is already clean, call no tools at all.',
].join('\n')
