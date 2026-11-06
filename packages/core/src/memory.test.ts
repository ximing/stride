import { describe, expect, it } from 'vitest'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import {
  buildMemorySection,
  containsConfiguredSecret,
  CURATE_MEMORY_PROMPT,
  DISTILL_MEMORY_PROMPT,
  distillableSlice,
  emptyMemoryIndex,
  GLOBAL_MEMORY_BUDGET,
  MEMORY_LOG_MAX_LINES,
  newMemoryId,
  parseMemoryEntry,
  parseMemoryIndex,
  PROJECT_MEMORY_BUDGET,
  rotateLogLines,
  serializeMemoryEntry,
  serializeMemoryIndex,
  shouldCurate,
  summarizeMemoryContent,
  upsertIndexEntry,
  type MemoryEntry,
  type MemoryIndex,
  type MemoryIndexEntry,
} from './memory.ts'

function indexEntry(partial: Partial<MemoryIndexEntry> & { id: string }): MemoryIndexEntry {
  return {
    kind: 'fact',
    title: partial.id,
    summary: `summary of ${partial.id}`,
    tags: [],
    status: 'active',
    updatedAt: '2026-11-06T09:00:00.000Z',
    sessionId: '',
    supersedes: [],
    ...partial,
  }
}

function memoryEntry(partial: Partial<MemoryEntry> & { id: string }): MemoryEntry {
  return {
    format: 1,
    kind: 'fact',
    title: partial.id,
    content: `content of ${partial.id}`,
    tags: [],
    createdAt: '2026-11-06T09:00:00.000Z',
    updatedAt: '2026-11-06T09:00:00.000Z',
    source: { sessionId: '', noteIds: [] },
    status: 'active',
    ...partial,
  }
}

describe('newMemoryId', () => {
  it('uses the mem_ prefix and produces unique ids', () => {
    const first = newMemoryId()
    expect(first.startsWith('mem_')).toBe(true)
    expect(newMemoryId()).not.toBe(first)
  })
})

describe('emptyMemoryIndex', () => {
  it('starts with format 1 and no entries', () => {
    expect(emptyMemoryIndex('2026-11-06T00:00:00.000Z')).toEqual({
      format: 1,
      updatedAt: '2026-11-06T00:00:00.000Z',
      distillCount: 0,
      entries: [],
    })
  })
})

describe('memory index serialization', () => {
  it('round-trips a serialized index', () => {
    const index: MemoryIndex = {
      format: 1,
      updatedAt: '2026-11-06T09:00:00.000Z',
      distillCount: 3,
      entries: [indexEntry({ id: 'mem_a' })],
    }
    expect(parseMemoryIndex(serializeMemoryIndex(index))).toEqual(index)
  })

  it('returns null for bad data', () => {
    expect(parseMemoryIndex('not json')).toBeNull()
    expect(parseMemoryIndex('{"format":2}')).toBeNull()
    expect(parseMemoryIndex('null')).toBeNull()
  })

  it('normalizes missing fields and drops malformed entries', () => {
    const parsed = parseMemoryIndex(JSON.stringify({
      format: 1,
      entries: [
        { id: 'mem_a', kind: 'unknown-kind', status: 'archived' },
        { title: 'no id' },
        'junk',
      ],
    }))
    expect(parsed).not.toBeNull()
    expect(parsed?.distillCount).toBe(0)
    expect(parsed?.entries).toHaveLength(1)
    expect(parsed?.entries[0]).toMatchObject({
      id: 'mem_a',
      kind: 'fact',
      status: 'archived',
      tags: [],
      supersedes: [],
      summary: '',
    })
  })
})

describe('memory entry serialization', () => {
  it('round-trips a serialized entry', () => {
    const entry = memoryEntry({ id: 'mem_a', source: { sessionId: 'ses_1', noteIds: ['n1'] } })
    expect(parseMemoryEntry(serializeMemoryEntry(entry))).toEqual(entry)
  })

  it('returns null for bad data', () => {
    expect(parseMemoryEntry('oops')).toBeNull()
    expect(parseMemoryEntry('{"format":1}')).toBeNull()
  })

  it('normalizes a missing source', () => {
    const parsed = parseMemoryEntry(JSON.stringify({ format: 1, id: 'mem_a' }))
    expect(parsed?.source).toEqual({ sessionId: '', noteIds: [] })
    expect(parsed?.status).toBe('active')
  })
})

describe('upsertIndexEntry', () => {
  it('appends a new entry and bumps updatedAt, keeping distillCount', () => {
    const index: MemoryIndex = { ...emptyMemoryIndex('2026-11-06T08:00:00.000Z'), distillCount: 7 }
    const next = upsertIndexEntry(index, indexEntry({ id: 'mem_a', updatedAt: '2026-11-06T09:00:00.000Z' }))
    expect(next.entries.map((entry) => entry.id)).toEqual(['mem_a'])
    expect(next.updatedAt).toBe('2026-11-06T09:00:00.000Z')
    expect(next.distillCount).toBe(7)
  })

  it('replaces the entry with the same id in place', () => {
    const index: MemoryIndex = {
      ...emptyMemoryIndex(),
      entries: [
        indexEntry({ id: 'mem_a', title: 'old' }),
        indexEntry({ id: 'mem_b' }),
      ],
    }
    const next = upsertIndexEntry(index, indexEntry({ id: 'mem_a', title: 'new', updatedAt: '2026-11-06T10:00:00.000Z' }))
    expect(next.entries).toHaveLength(2)
    expect(next.entries[0]?.title).toBe('new')
    expect(next.entries[1]?.id).toBe('mem_b')
  })
})

describe('summarizeMemoryContent', () => {
  it('takes the first non-empty line and collapses whitespace', () => {
    expect(summarizeMemoryContent('\n  first   line \nsecond')).toBe('first line')
  })

  it('caps the summary length', () => {
    expect(summarizeMemoryContent('x'.repeat(500))).toHaveLength(120)
  })

  it('returns an empty summary for empty content', () => {
    expect(summarizeMemoryContent('\n \n')).toBe('')
  })
})

describe('buildMemorySection', () => {
  it('is empty when there are no memories', () => {
    expect(buildMemorySection({ project: null, global: null })).toBe('')
    expect(buildMemorySection({ project: emptyMemoryIndex(), global: emptyMemoryIndex() })).toBe('')
  })

  it('lists project memory before global memory with scope labels', () => {
    const section = buildMemorySection({
      project: { ...emptyMemoryIndex(), entries: [indexEntry({ id: 'mem_p', kind: 'preference', title: 'Reply language', summary: 'Chinese, English identifiers' })] },
      global: { ...emptyMemoryIndex(), entries: [indexEntry({ id: 'mem_g', kind: 'decision', title: 'Commit style', summary: 'imperative, no scope' })] },
    })
    expect(section).toContain('### Project memory (this vault)')
    expect(section).toContain('### Global memory (all vaults)')
    expect(section).toContain('- [preference] Reply language — Chinese, English identifiers (mem_p)')
    expect(section).toContain('- [decision] Commit style — imperative, no scope (mem_g)')
    expect(section.indexOf('mem_p')).toBeLessThan(section.indexOf('mem_g'))
  })

  it('skips archived entries and sorts newest first', () => {
    const section = buildMemorySection({
      project: {
        ...emptyMemoryIndex(),
        entries: [
          indexEntry({ id: 'mem_old', updatedAt: '2026-11-01T00:00:00.000Z' }),
          indexEntry({ id: 'mem_archived', status: 'archived', updatedAt: '2026-11-05T00:00:00.000Z' }),
          indexEntry({ id: 'mem_new', updatedAt: '2026-11-06T00:00:00.000Z' }),
        ],
      },
      global: null,
    })
    expect(section).not.toContain('mem_archived')
    expect(section.indexOf('mem_new')).toBeLessThan(section.indexOf('mem_old'))
  })

  it('truncates the project scope at its budget and notes the remainder', () => {
    const filler = 'x'.repeat(180)
    const entries = Array.from({ length: 20 }, (_, index) => indexEntry({
      id: `mem_${String(index).padStart(2, '0')}`,
      summary: filler,
      updatedAt: `2026-11-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
    }))
    const section = buildMemorySection({ project: { ...emptyMemoryIndex(), entries }, global: null })
    const shown = section.split('\n').filter((line) => line.startsWith('- [')).length
    const bodyLength = section.split('\n').filter((line) => line.startsWith('- ')).join('\n').length
    expect(shown).toBeGreaterThan(0)
    expect(shown).toBeLessThan(20)
    expect(bodyLength).toBeLessThanOrEqual(PROJECT_MEMORY_BUDGET + 80) // entries fit, only the note line may overflow
    expect(section).toContain(`- … ${20 - shown} more entries; call memory_read`)
  })

  it('applies the smaller global budget', () => {
    const big = 'y'.repeat(GLOBAL_MEMORY_BUDGET) // a single line that cannot fit
    const section = buildMemorySection({
      project: null,
      global: { ...emptyMemoryIndex(), entries: [indexEntry({ id: 'mem_big', summary: big })] },
    })
    expect(section).not.toContain('mem_big')
    expect(section).toContain('- … 1 more entries; call memory_read')
  })
})

describe('containsConfiguredSecret', () => {
  it('detects any configured secret in the text', () => {
    expect(containsConfiguredSecret('the key is sk-live-123 ok', ['sk-live-123', 'other'])).toBe(true)
    expect(containsConfiguredSecret('nothing here', ['sk-live-123'])).toBe(false)
  })

  it('ignores empty secrets', () => {
    expect(containsConfiguredSecret('anything', ['', ''])).toBe(false)
    expect(containsConfiguredSecret('', ['sk-live-123'])).toBe(false)
  })
})

describe('rotateLogLines', () => {
  it('keeps the lines when under the cap', () => {
    const lines = Array.from({ length: MEMORY_LOG_MAX_LINES }, (_, index) => `line-${index}`)
    expect(rotateLogLines(lines)).toBe(lines)
  })

  it('keeps the newest half when over the cap', () => {
    const lines = Array.from({ length: MEMORY_LOG_MAX_LINES + 1 }, (_, index) => `line-${index}`)
    const rotated = rotateLogLines(lines)
    expect(rotated).toHaveLength(MEMORY_LOG_MAX_LINES / 2)
    expect(rotated[0]).toBe(`line-${MEMORY_LOG_MAX_LINES + 1 - MEMORY_LOG_MAX_LINES / 2}`)
    expect(rotated[rotated.length - 1]).toBe(`line-${MEMORY_LOG_MAX_LINES}`)
  })
})

describe('distillableSlice', () => {
  const user = (text: string) => ({ role: 'user', content: text, timestamp: 1 }) as AgentMessage
  const assistant = (text: string, stopReason = 'stop') =>
    ({ role: 'assistant', content: [{ type: 'text', text }], stopReason, timestamp: 2 }) as unknown as AgentMessage

  it('returns the increment from the cursor', () => {
    const transcript = [user('a'), assistant('b'), user('c'), assistant('d')]
    expect(distillableSlice(transcript, 2)).toEqual(transcript.slice(2))
    expect(distillableSlice(transcript, 0)).toEqual(transcript)
    expect(distillableSlice(transcript, 4)).toEqual([])
  })

  it('drops trailing aborted assistant messages', () => {
    const transcript = [user('a'), assistant('partial', 'aborted')]
    expect(distillableSlice(transcript, 1)).toEqual([])
    const longer = [user('a'), assistant('b'), user('c'), assistant('half', 'aborted')]
    expect(distillableSlice(longer, 2)).toEqual([longer[2]])
  })

  it('keeps aborted messages that are not at the tail', () => {
    const transcript = [user('a'), assistant('half', 'aborted'), user('b'), assistant('done')]
    expect(distillableSlice(transcript, 0)).toEqual(transcript)
  })
})

describe('shouldCurate', () => {
  const entry = (id: string, status: 'active' | 'archived' = 'active'): MemoryIndexEntry => ({
    id,
    kind: 'fact',
    title: id,
    summary: id,
    tags: [],
    status,
    updatedAt: '2026-11-06T09:00:00.000Z',
    sessionId: '',
    supersedes: [],
  })

  it('triggers every tenth distillation', () => {
    const index: MemoryIndex = { ...emptyMemoryIndex('2026-11-06T09:00:00.000Z'), distillCount: 10 }
    expect(shouldCurate('project', index)).toBe(true)
    expect(shouldCurate('project', { ...index, distillCount: 9 })).toBe(false)
    expect(shouldCurate('project', { ...index, distillCount: 0 })).toBe(false)
    expect(shouldCurate('project', null)).toBe(false)
  })

  it('triggers past the active-entry limits per scope', () => {
    const entries = Array.from({ length: 101 }, (_, index) => entry(`mem_${index}`))
    const project: MemoryIndex = { ...emptyMemoryIndex(), entries }
    expect(shouldCurate('project', project)).toBe(true)
    // 75 entries clear the global limit but not the project one.
    const between: MemoryIndex = { ...emptyMemoryIndex(), entries: entries.slice(0, 75) }
    expect(shouldCurate('project', between)).toBe(false)
    expect(shouldCurate('global', between)).toBe(true)
    // Archived entries do not count.
    const archived: MemoryIndex = {
      ...emptyMemoryIndex(),
      entries: entries.map((item) => ({ ...item, status: 'archived' as const })),
    }
    expect(shouldCurate('project', archived)).toBe(false)
  })
})

describe('memory prompts', () => {
  it('pins the distillation prompt contract', () => {
    expect(DISTILL_MEMORY_PROMPT).toContain('memory_write')
    expect(DISTILL_MEMORY_PROMPT).toContain('call no tools')
    expect(DISTILL_MEMORY_PROMPT).toContain('no API keys')
  })

  it('pins the curation prompt rules', () => {
    expect(CURATE_MEMORY_PROMPT).toContain('Conflicts')
    expect(CURATE_MEMORY_PROMPT).toContain('Stale')
    expect(CURATE_MEMORY_PROMPT).toContain('Corrupt')
    expect(CURATE_MEMORY_PROMPT).toContain('Merge')
    expect(CURATE_MEMORY_PROMPT).toContain('memory_forget')
  })
})
