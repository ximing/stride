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
    vault: { label: 'Field notes', noteCount: 2, titles: ['Moss garden', 'Fern'] },
    ...overrides,
  }
}

function snapshotOf(text: string): {
  activeNote: (AgentContextNote & {
    text: string
    textChars: number
    textShownChars: number
    textTruncated: boolean
  }) | null
  openTabs: { id: string; title: string }[]
  tabsShown: number
  tabsTruncated: boolean
  vault: {
    label: string
    noteCount: number
    titles: string[]
    titlesShown: number
    titlesTruncated: boolean
  }
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
    expect(snapshot.activeNote?.textChars).toBe(2004)
    expect(snapshot.activeNote?.textShownChars).toBe(2000)
    expect(snapshot.activeNote?.textTruncated).toBe(true)
    expect(out).toContain('Active note text shows 2000 of 2004 characters.')
    expect(out).toContain('Vault titles show 2 of 12.')
    expect(out).toContain('This snapshot omits the rest. Use read_note, search_vault, or list_notes before answering from it.')
    expect(snapshot.activeNote?.properties).toEqual({ status: 'draft', topic: 'ferns' })
    expect(snapshot.openTabs).toEqual([
      { id: 'n1', title: 'Moss garden' },
      { id: 'n2', title: 'Fern tab' },
    ])
    expect(snapshot.vault.noteCount).toBe(12)
    expect(snapshot.vault.titlesShown).toBe(2)
    expect(snapshot.vault.titlesTruncated).toBe(true)
    expect(snapshot.tabsShown).toBe(2)
    expect(snapshot.tabsTruncated).toBe(false)
    expect(source.text).toBe(text)
    expect(titles).toEqual(['Moss garden', 'Fern'])
    expect(Object.hasOwn(snapshot, 'apiKey')).toBe(false)
    expect(Object.keys(snapshot)).toEqual(['activeNote', 'openTabs', 'tabsShown', 'tabsTruncated', 'vault'])
    expect(Object.keys(snapshot.vault)).toEqual(['label', 'noteCount', 'titles', 'titlesShown', 'titlesTruncated'])
    expect(Object.keys(snapshot.activeNote ?? {})).toEqual([
      'id',
      'title',
      'type',
      'properties',
      'text',
      'textChars',
      'textShownChars',
      'textTruncated',
    ])
  })

  it('keeps a short body in full with no truncated marker', () => {
    const out = buildAgentContext(input())
    const snapshot = snapshotOf(out)
    expect(out).not.toContain('[truncated]')
    expect(out).not.toContain('omits the rest')
    expect(out).not.toContain('shows ')
    expect(snapshot.activeNote?.text).toBe('short body')
    expect(snapshot.activeNote?.textChars).toBe('short body'.length)
    expect(snapshot.activeNote?.textShownChars).toBe(snapshot.activeNote?.textChars)
    expect(snapshot.activeNote?.textTruncated).toBe(false)
    expect(snapshot.vault.titlesTruncated).toBe(false)
    expect(snapshot.tabsTruncated).toBe(false)
    expect(snapshot.activeNote?.properties).toEqual({ status: 'draft' })
  })

  it('leaves a 2000-character body untouched', () => {
    const text = 'b'.repeat(2000)
    const out = buildAgentContext(input({ activeNote: note(text) }))
    const snapshot = snapshotOf(out)
    expect(snapshot.activeNote?.text).toBe(text)
    expect(snapshot.activeNote?.textShownChars).toBe(2000)
    expect(snapshot.activeNote?.textTruncated).toBe(false)
    expect(out).not.toContain('omits the rest')
    expect(out).not.toContain('[truncated]')
  })

  it('says no note is open and emits null activeNote', () => {
    const out = buildAgentContext(input({ activeNote: null, openTabs: [] }))
    const snapshot = snapshotOf(out)
    expect(out).toContain('No note is open.')
    expect(snapshot.activeNote).toBeNull()
    expect(snapshot.openTabs).toEqual([])
    expect(out).not.toContain('textChars')
    expect(out).not.toContain('textShownChars')
    expect(out).not.toContain('textTruncated')
    expect(out).not.toContain('omits the rest')
  })

  it('caps vault titles at 40 in the given order', () => {
    const titles = Array.from({ length: 45 }, (_, index) => `Note ${index}`)
    const snapshot = snapshotOf(
      buildAgentContext(input({ vault: { label: 'Field notes', noteCount: 45, titles } })),
    )
    expect(snapshot.vault.titles).toEqual(titles.slice(0, 40))
    expect(snapshot.vault.titlesShown).toBe(40)
    expect(snapshot.vault.titlesTruncated).toBe(true)
    expect(snapshot.vault.label).toBe('Field notes')
    expect(titles).toHaveLength(45)
    const out = buildAgentContext(input({ vault: { label: 'Field notes', noteCount: 45, titles } }))
    expect(out).toContain('Vault titles show 40 of 45.')
    expect(out).toContain('Use read_note, search_vault, or list_notes before answering from it.')
    expect(out).not.toContain('Active note text shows')
    expect(out).not.toContain('Open tabs show')
  })

  it('caps open tabs at 20 and says how many were omitted', () => {
    const openTabs = Array.from({ length: 21 }, (_, index) => ({ id: `n${index}`, title: `Tab ${index}` }))
    const out = buildAgentContext(input({
      activeNote: note('short body'),
      openTabs,
      vault: { label: 'Field notes', noteCount: 1, titles: ['Moss garden'] },
    }))
    const snapshot = snapshotOf(out)
    expect(snapshot.openTabs).toEqual(openTabs.slice(0, 20))
    expect(snapshot.tabsShown).toBe(20)
    expect(snapshot.tabsTruncated).toBe(true)
    expect(out).toContain('Open tabs show 20 of 21.')
    expect(out).not.toContain('Active note text shows')
    expect(out).not.toContain('Vault titles show')
    expect(openTabs).toHaveLength(21)
  })

  it('does not mention a cut when the note, titles, and tabs all fit', () => {
    const out = buildAgentContext(input({
      openTabs: Array.from({ length: 20 }, (_, index) => ({ id: `n${index}`, title: `Tab ${index}` })),
      vault: { label: 'Field notes', noteCount: 40, titles: Array.from({ length: 40 }, (_, index) => `Note ${index}`) },
    }))
    const snapshot = snapshotOf(out)
    expect(snapshot.tabsShown).toBe(20)
    expect(snapshot.tabsTruncated).toBe(false)
    expect(snapshot.vault.titlesShown).toBe(40)
    expect(snapshot.vault.titlesTruncated).toBe(false)
    expect(out).not.toContain('omits the rest')
    expect(out).not.toContain('shows ')
  })
})
