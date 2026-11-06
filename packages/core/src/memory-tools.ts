import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'
import {
  containsConfiguredSecret,
  emptyMemoryIndex,
  MEMORY_KINDS,
  newMemoryId,
  summarizeMemoryContent,
  upsertIndexEntry,
  type MemoryEntry,
  type MemoryIndex,
  type MemoryIndexEntry,
  type MemoryKind,
  type MemoryScope,
} from './memory.ts'

/**
 * Minimal host contract for the memory tools. Core declares what it needs;
 * the desktop host (`chat-memory-host`) implements it over `AppDataStore`
 * with a serial write queue and Web Locks.
 */
export interface MemoryToolHost {
  readIndex(scope: MemoryScope): Promise<MemoryIndex | null> | MemoryIndex | null
  writeIndex(scope: MemoryScope, index: MemoryIndex): Promise<void> | void
  readEntry(scope: MemoryScope, id: string): Promise<MemoryEntry | null> | MemoryEntry | null
  writeEntry(scope: MemoryScope, entry: MemoryEntry): Promise<void> | void
  appendLog(scope: MemoryScope, line: string): Promise<void> | void
  /** All currently configured API keys (llm configs + embedding); used to refuse secret writes. */
  secretValues(): string[]
}

export interface MemoryToolOptions {
  /** Provenance stamped onto newly created entries. */
  source?: { sessionId?: string; noteIds?: string[] }
  /** Actor recorded in the memory log; 'agent' for chat turns, 'distill'/'curate' for background passes. */
  actor?: 'agent' | 'distill' | 'curate' | 'user'
  /** Clock override for tests. */
  now?: () => Date
}

function toolText(text: string, details: unknown = null) {
  return { content: [{ type: 'text' as const, text }], details }
}

function toolError(text: string, details: unknown = null) {
  return { content: [{ type: 'text' as const, text }], details, isError: true }
}

const scopeSchema = Type.Union([Type.Literal('project'), Type.Literal('global')])
const kindSchema = Type.Union(MEMORY_KINDS.map((kind) => Type.Literal(kind)))

function asKind(value: unknown): MemoryKind {
  if (!(MEMORY_KINDS as readonly string[]).includes(value as string)) {
    throw new Error(`kind must be one of ${MEMORY_KINDS.join(', ')}`)
  }
  return value as MemoryKind
}

function asTags(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter((item) => item !== '')
}

function entryPayload(scope: MemoryScope, entry: MemoryEntry) {
  return {
    scope,
    id: entry.id,
    kind: entry.kind,
    title: entry.title,
    content: entry.content,
    tags: entry.tags,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    status: entry.status,
    source: entry.source,
  }
}

export function memoryTools(host: MemoryToolHost, options: MemoryToolOptions = {}): AgentTool[] {
  const nowIso = () => (options.now ?? (() => new Date()))().toISOString()
  const actor = options.actor ?? 'agent'
  const log = async (scope: MemoryScope, record: { op: string; id: string; reason: string }) => {
    await host.appendLog(scope, JSON.stringify({ ts: nowIso(), actor, ...record }))
  }

  const read: AgentTool = {
    name: 'memory_read',
    label: 'Read memory',
    description: 'Read one long-term memory entry by id. Omit scope to check project memory first, then global.',
    parameters: Type.Object({
      id: Type.String({ minLength: 1 }),
      scope: Type.Optional(scopeSchema),
    }),
    execute: async (_toolCallId, params) => {
      const record = params as { id: string; scope?: MemoryScope }
      const scopes: MemoryScope[] = record.scope ? [record.scope] : ['project', 'global']
      for (const scope of scopes) {
        const entry = await host.readEntry(scope, record.id)
        if (entry) return toolText(JSON.stringify(entryPayload(scope, entry)), { id: record.id, scope })
      }
      return toolError(`memory ${record.id} not found`, { id: record.id })
    },
  }

  const write: AgentTool = {
    name: 'memory_write',
    label: 'Write memory',
    description: 'Save a durable preference, fact, decision, context, or correction. Pass the id of an existing entry to overwrite it on the same topic; omit id to create. Never store API keys, tokens, or passwords.',
    parameters: Type.Object({
      id: Type.Optional(Type.String()),
      scope: scopeSchema,
      kind: kindSchema,
      title: Type.String({ minLength: 1 }),
      content: Type.String({ minLength: 1 }),
      tags: Type.Optional(Type.Array(Type.String())),
    }),
    execute: async (_toolCallId, params) => {
      const record = params as {
        id?: string
        scope: MemoryScope
        kind: MemoryKind
        title: string
        content: string
        tags?: string[]
      }
      const title = record.title.trim()
      if (!title) throw new Error('Title is required')
      if (!record.content.trim()) throw new Error('Content is required')
      const kind = asKind(record.kind)
      if (containsConfiguredSecret(record.content, host.secretValues())) {
        return toolError('refusing to store a configured secret in memory', { scope: record.scope })
      }
      const tags = asTags(record.tags)
      const stamp = nowIso()
      const scope = record.scope
      if (record.id !== undefined) {
        const existing = await host.readEntry(scope, record.id)
        if (!existing) return toolError(`memory ${record.id} not found in ${scope} scope`, { id: record.id, scope })
        const entry: MemoryEntry = {
          ...existing,
          kind,
          title,
          content: record.content,
          tags,
          updatedAt: stamp,
          status: 'active',
        }
        await host.writeEntry(scope, entry)
        const index = (await host.readIndex(scope)) ?? emptyMemoryIndex(stamp)
        const previous = index.entries.find((item) => item.id === record.id)
        const indexEntry: MemoryIndexEntry = {
          id: record.id,
          kind,
          title,
          summary: summarizeMemoryContent(record.content),
          tags,
          status: 'active',
          updatedAt: stamp,
          sessionId: options.source?.sessionId ?? previous?.sessionId ?? '',
          supersedes: previous?.supersedes ?? [],
        }
        await host.writeIndex(scope, upsertIndexEntry(index, indexEntry))
        await log(scope, { op: 'write', id: record.id, reason: `update: ${title}` })
        return toolText(`updated memory ${record.id} (${scope})`, { id: record.id, scope })
      }
      const id = newMemoryId()
      const entry: MemoryEntry = {
        format: 1,
        id,
        kind,
        title,
        content: record.content,
        tags,
        createdAt: stamp,
        updatedAt: stamp,
        source: {
          sessionId: options.source?.sessionId ?? '',
          noteIds: options.source?.noteIds ?? [],
        },
        status: 'active',
      }
      await host.writeEntry(scope, entry)
      const index = (await host.readIndex(scope)) ?? emptyMemoryIndex(stamp)
      const indexEntry: MemoryIndexEntry = {
        id,
        kind,
        title,
        summary: summarizeMemoryContent(record.content),
        tags,
        status: 'active',
        updatedAt: stamp,
        sessionId: options.source?.sessionId ?? '',
        supersedes: [],
      }
      await host.writeIndex(scope, upsertIndexEntry(index, indexEntry))
      await log(scope, { op: 'write', id, reason: `create: ${title}` })
      return toolText(`saved memory ${id} (${scope})`, { id, scope })
    },
  }

  const forget: AgentTool = {
    name: 'memory_forget',
    label: 'Forget memory',
    description: 'Archive a memory entry and remove it from the index. The entry file is kept for audit; the reason is written to the memory log.',
    parameters: Type.Object({
      id: Type.String({ minLength: 1 }),
      scope: Type.Optional(scopeSchema),
      reason: Type.String({ minLength: 1 }),
    }),
    execute: async (_toolCallId, params) => {
      const record = params as { id: string; scope?: MemoryScope; reason: string }
      if (!record.reason.trim()) throw new Error('Reason is required')
      const scopes: MemoryScope[] = record.scope ? [record.scope] : ['project', 'global']
      for (const scope of scopes) {
        const entry = await host.readEntry(scope, record.id)
        if (!entry) continue
        const stamp = nowIso()
        await host.writeEntry(scope, { ...entry, status: 'archived', updatedAt: stamp })
        const index = (await host.readIndex(scope)) ?? emptyMemoryIndex(stamp)
        await host.writeIndex(scope, {
          ...index,
          updatedAt: stamp,
          entries: index.entries.filter((item) => item.id !== record.id),
        })
        await log(scope, { op: 'forget', id: record.id, reason: record.reason })
        return toolText(`forgot memory ${record.id} (${scope})`, { id: record.id, scope })
      }
      return toolError(`memory ${record.id} not found`, { id: record.id })
    },
  }

  return [read, write, forget]
}
