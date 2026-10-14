import { describe, expect, it } from 'vitest'
import { buildAgentContext, type AgentContextInput, type AgentContextNote } from './context-snapshot.ts'

function note(text: string, properties: Record<string, unknown> = { status: 'draft' }): AgentContextNote {
  return {
    id: 'n1',
    title: 'Moss garden',
    type: 'note',
    properties,
    text,
  }
}

function input(overrides: Partial<AgentContextInput> = {}): AgentContextInput {
  return {
    activeNote: note('short body'),
    openTabs: [{ id: 'n1', title: 'Moss garden' }],
    vault: { label: 'Field notes', noteCount: 3, titles: ['Moss garden', 'Fern'] },
    ...overrides,
  }
}

function snapshotOf(text: string): {
  activeNote: (AgentContextNote & { text: string }) | null
  openTabs: { id: string; title: string }[]
  vault: { label: string; noteCount: number; titles: string[] }
} {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  return JSON.parse(text.slice(start, end + 1))
}

describe('buildAgentContext', () => {
  it('includes the active note title, a tab title, noteCount, and the truncated marker', () => {
    const text = `${'a'.repeat(2000)}TAIL`
    const source = note(text, { status: 'draft', topic: 'ferns' })
    const titles = ['Moss garden', 'Fern']
    const out = buildAgentContext(
      input({
        activeNote: source,
        openTabs: [
          { id: 'n1', title: 'Moss garden' },
          { id: 'n2', title: 'Fern tab' },
        ],
        vault: { label: 'Field notes', noteCount: 12, titles },
      }),
    )
    const snapshot = snapshotOf(out)
    expect(out).toContain('Moss garden')
    expect(out).toContain('Fern tab')
    expect(out).toContain('noteCount')
    expect(out).toContain('…[truncated]')
    expect(snapshot.activeNote?.title).toBe('Moss garden')
    expect(snapshot.activeNote?.text).toBe(`${'a'.repeat(2000)}\n…[truncated]`)
    expect(snapshot.activeNote?.properties).toEqual({ status: 'draft', topic: 'ferns' })
    expect(snapshot.openTabs).toEqual([
      { id: 'n1', title: 'Moss garden' },
      { id: 'n2', title: 'Fern tab' },
    ])
    expect(snapshot.vault.noteCount).toBe(12)
    expect(source.text).toBe(text)
    expect(titles).toEqual(['Moss garden', 'Fern'])
    expect(Object.hasOwn(snapshot, 'apiKey')).toBe(false)
    expect(Object.keys(snapshot)).toEqual(['activeNote', 'openTabs', 'vault'])
  })

  it('keeps a short body in full with no truncated marker', () => {
    const out = buildAgentContext(input())
    const snapshot = snapshotOf(out)
    expect(out).not.toContain('[truncated]')
    expect(snapshot.activeNote?.text).toBe('short body')
    expect(snapshot.activeNote?.properties).toEqual({ status: 'draft' })
  })

  it('leaves a 2000-character body untouched', () => {
    const text = 'b'.repeat(2000)
    const snapshot = snapshotOf(buildAgentContext(input({ activeNote: note(text) })))
    expect(snapshot.activeNote?.text).toBe(text)
  })

  it('says no note is open and emits null activeNote', () => {
    const out = buildAgentContext(input({ activeNote: null, openTabs: [] }))
    const snapshot = snapshotOf(out)
    expect(out).toContain('No note is open.')
    expect(snapshot.activeNote).toBeNull()
    expect(snapshot.openTabs).toEqual([])
  })

  it('caps vault titles at 40 in the given order', () => {
    const titles = Array.from({ length: 45 }, (_, index) => `Note ${index}`)
    const snapshot = snapshotOf(
      buildAgentContext(input({ vault: { label: 'Field notes', noteCount: 45, titles } })),
    )
    expect(snapshot.vault.titles).toEqual(titles.slice(0, 40))
    expect(snapshot.vault.label).toBe('Field notes')
    expect(titles).toHaveLength(45)
  })
})
