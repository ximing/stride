import { beforeEach, describe, expect, it } from 'vitest'
import type { AgentToolResult } from '@earendil-works/pi-agent-core'
import {
  emptyMemoryIndex,
  parseMemoryIndex,
  type MemoryEntry,
  type MemoryIndex,
  type MemoryScope,
} from './memory.ts'
import { memoryTools, type MemoryToolHost, type MemoryToolOptions } from './memory-tools.ts'

interface Double {
  host: MemoryToolHost
  indexes: Record<MemoryScope, MemoryIndex | null>
  entries: Record<MemoryScope, Map<string, MemoryEntry>>
  logs: Record<MemoryScope, string[]>
  secrets: string[]
}

function makeDouble(): Double {
  const double: Double = {
    indexes: { project: null, global: null },
    entries: { project: new Map(), global: new Map() },
    logs: { project: [], global: [] },
    secrets: [],
    host: null as unknown as MemoryToolHost,
  }
  double.host = {
    readIndex: (scope) => double.indexes[scope],
    writeIndex: (scope, index) => {
      double.indexes[scope] = index
    },
    readEntry: (scope, id) => double.entries[scope].get(id) ?? null,
    writeEntry: (scope, entry) => {
      double.entries[scope].set(entry.id, entry)
    },
    appendLog: (scope, line) => {
      double.logs[scope].push(line)
    },
    secretValues: () => double.secrets,
  }
  return double
}

function makeTools(double: Double, options: MemoryToolOptions = {}) {
  const tools = memoryTools(double.host, options)
  const byName = new Map(tools.map((tool) => [tool.name, tool]))
  const call = (name: string, params: Record<string, unknown>): Promise<AgentToolResult<unknown>> => {
    const tool = byName.get(name)
    if (!tool) throw new Error(`missing tool ${name}`)
    return tool.execute('call-1', params as never)
  }
  return { tools, byName, call }
}

function text(result: AgentToolResult<unknown>): string {
  const part = result.content[0]
  return part && part.type === 'text' ? part.text : ''
}

let clock = 0
const tick = () => new Date(`2026-11-06T09:00:0${clock++}.000Z`)

beforeEach(() => {
  clock = 0
})

describe('memoryTools', () => {
  it('exposes memory_read, memory_write, and memory_forget', () => {
    const { tools } = makeTools(makeDouble())
    expect(tools.map((tool) => tool.name)).toEqual(['memory_read', 'memory_write', 'memory_forget'])
  })

  it('creates an entry and its index record on memory_write', async () => {
    const double = makeDouble()
    const { call } = makeTools(double, { now: tick, source: { sessionId: 'ses_1' } })
    const result = await call('memory_write', {
      scope: 'project',
      kind: 'preference',
      title: 'Reply language',
      content: 'User prefers Chinese replies.\nKeep identifiers in English.',
      tags: ['language'],
    })
    expect(result.isError).toBeUndefined()
    expect(text(result)).toMatch(/^saved memory mem_/)
    const [entry] = [...double.entries.project.values()]
    expect(entry?.kind).toBe('preference')
    expect(entry?.status).toBe('active')
    expect(entry?.source).toEqual({ sessionId: 'ses_1', noteIds: [] })
    const index = double.indexes.project
    expect(index?.entries).toHaveLength(1)
    expect(index?.entries[0]).toMatchObject({
      id: entry?.id,
      title: 'Reply language',
      summary: 'User prefers Chinese replies.',
      tags: ['language'],
      sessionId: 'ses_1',
      supersedes: [],
    })
  })

  it('refuses to store a configured secret', async () => {
    const double = makeDouble()
    double.secrets.push('sk-live-123')
    const { call } = makeTools(double, { now: tick })
    const result = await call('memory_write', {
      scope: 'global',
      kind: 'fact',
      title: 'Provider key',
      content: 'The key is sk-live-123.',
    })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('refusing')
    expect(double.entries.global.size).toBe(0)
    expect(double.indexes.global).toBeNull()
  })

  it('overwrites an existing entry by id, keeping createdAt and supersedes', async () => {
    const double = makeDouble()
    const { call } = makeTools(double, { now: tick, source: { sessionId: 'ses_1' } })
    const created = await call('memory_write', {
      scope: 'project',
      kind: 'decision',
      title: 'Commit style',
      content: 'Imperative subject lines.',
    })
    const id = text(created).match(/mem_\S+/)?.[0] ?? ''
    const first = double.entries.project.get(id)
    double.indexes.project = {
      ...double.indexes.project!,
      entries: double.indexes.project!.entries.map((entry) => entry.id === id ? { ...entry, supersedes: ['mem_older'] } : entry),
    }
    const updated = await call('memory_write', {
      id,
      scope: 'project',
      kind: 'decision',
      title: 'Commit style',
      content: 'Imperative, no scope prefix; enforced by commit-check.',
    })
    expect(text(updated)).toBe(`updated memory ${id} (project)`)
    const entry = double.entries.project.get(id)
    expect(entry?.content).toContain('no scope prefix')
    expect(entry?.createdAt).toBe(first?.createdAt)
    expect(entry?.updatedAt).not.toBe(first?.updatedAt)
    const indexEntry = double.indexes.project?.entries.find((item) => item.id === id)
    expect(indexEntry?.summary).toBe('Imperative, no scope prefix; enforced by commit-check.')
    expect(indexEntry?.supersedes).toEqual(['mem_older'])
  })

  it('returns an error text when overwriting a missing id', async () => {
    const double = makeDouble()
    const { call } = makeTools(double, { now: tick })
    const result = await call('memory_write', {
      id: 'mem_missing',
      scope: 'project',
      kind: 'fact',
      title: 'Nope',
      content: 'nothing',
    })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('not found')
    expect(double.entries.project.size).toBe(0)
  })

  it('resolves memory_read project-first, then global', async () => {
    const double = makeDouble()
    const { call } = makeTools(double, { now: tick })
    await call('memory_write', { scope: 'global', kind: 'fact', title: 'Shared', content: 'global version' })
    const id = [...double.entries.global.keys()][0]!
    // Same id exists in both scopes: project must win.
    double.entries.project.set(id, { ...double.entries.global.get(id)!, content: 'project version' })
    const resolved = await call('memory_read', { id })
    expect(text(resolved)).toContain('project version')
    const globalRead = await call('memory_read', { id, scope: 'global' })
    expect(text(globalRead)).toContain('global version')
  })

  it('returns an error text when memory_read finds nothing', async () => {
    const double = makeDouble()
    const { call } = makeTools(double)
    const result = await call('memory_read', { id: 'mem_nope' })
    expect(result.isError).toBe(true)
    expect(text(result)).toBe('memory mem_nope not found')
  })

  it('archives the entry, removes it from the index, and logs on memory_forget', async () => {
    const double = makeDouble()
    const { call } = makeTools(double, { now: tick })
    await call('memory_write', { scope: 'project', kind: 'fact', title: 'Stale', content: 'outdated fact' })
    const id = [...double.entries.project.keys()][0]!
    const result = await call('memory_forget', { id, reason: 'superseded by a newer decision' })
    expect(text(result)).toBe(`forgot memory ${id} (project)`)
    expect(double.entries.project.get(id)?.status).toBe('archived')
    expect(double.indexes.project?.entries).toHaveLength(0)
    expect(double.logs.project).toHaveLength(2)
    const written = JSON.parse(double.logs.project[0]!) as Record<string, unknown>
    expect(written).toMatchObject({ op: 'write', id, actor: 'agent' })
    const record = JSON.parse(double.logs.project[1]!) as Record<string, unknown>
    expect(record).toMatchObject({ op: 'forget', id, reason: 'superseded by a newer decision', actor: 'agent' })
  })

  it('stamps the configured actor on write and forget log records', async () => {
    const double = makeDouble()
    const { call } = makeTools(double, { now: tick, actor: 'curate' })
    await call('memory_write', { scope: 'global', kind: 'fact', title: 'Merged', content: 'one fact' })
    const id = [...double.entries.global.keys()][0]!
    await call('memory_forget', { id, reason: 'merged' })
    const records = double.logs.global.map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(records.map((record) => record.actor)).toEqual(['curate', 'curate'])
  })

  it('returns an error text when memory_forget finds nothing', async () => {
    const double = makeDouble()
    const { call } = makeTools(double)
    const result = await call('memory_forget', { id: 'mem_nope', reason: 'cleanup' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('not found')
  })

  it('keeps parse-compatible output: written indexes and entries parse back', async () => {
    const double = makeDouble()
    const { call } = makeTools(double, { now: tick })
    await call('memory_write', { scope: 'global', kind: 'context', title: 'Stack', content: 'Tauri 2 + React 19' })
    expect(parseMemoryIndex(JSON.stringify(double.indexes.global))).not.toBeNull()
  })

  it('starts a fresh index when none exists for forget', async () => {
    const double = makeDouble()
    double.entries.global.set('mem_orphan', {
      format: 1,
      id: 'mem_orphan',
      kind: 'fact',
      title: 'Orphan',
      content: 'no index',
      tags: [],
      createdAt: '2026-11-06T09:00:00.000Z',
      updatedAt: '2026-11-06T09:00:00.000Z',
      source: { sessionId: '', noteIds: [] },
      status: 'active',
    })
    const { call } = makeTools(double, { now: tick })
    const result = await call('memory_forget', { id: 'mem_orphan', scope: 'global', reason: 'broken' })
    expect(result.isError).toBeUndefined()
    expect(double.indexes.global).toEqual({ ...emptyMemoryIndex('2026-11-06T09:00:00.000Z'), entries: [] })
  })
})
