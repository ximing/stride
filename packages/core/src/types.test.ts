import { describe, expect, it } from 'vitest'
import type { StrideNote } from './note.ts'
import {
  compareTypeDocuments,
  isTypeVisible,
  nextTypeOrder,
  templateBody,
  typeSidebarLabel,
  typeSortOrder,
} from './types.ts'

function typeNote(title: string, properties: StrideNote['properties'] = {}): StrideNote {
  return {
    id: title.toLowerCase(),
    title,
    type: 'Type',
    properties,
    doc: { type: 'doc', content: [{ type: 'paragraph' }] },
  }
}

describe('type documents', () => {
  it('sorts by numeric _order and skips a non-numeric value', () => {
    const early = typeNote('Early', { _order: '20' })
    const first = typeNote('First', { _order: '2' })
    const missing = typeNote('Missing')
    const broken = typeNote('Broken', { _order: 'nope' })
    expect(typeSortOrder(missing)).toBe(0)
    expect(typeSortOrder(broken)).toBe(Number.POSITIVE_INFINITY)
    expect([early, first, missing, broken].sort(compareTypeDocuments).map((note) => note.title)).toEqual([
      'Missing',
      'First',
      'Early',
      'Broken',
    ])
  })

  it('hides visible false and the string false only', () => {
    expect(isTypeVisible(typeNote('Shown'))).toBe(true)
    expect(isTypeVisible(typeNote('Shown', { visible: 'true' }))).toBe(true)
    expect(isTypeVisible(typeNote('Shown', { visible: ' false ' }))).toBe(false)
    expect(isTypeVisible(typeNote('Shown', { visible: ['false'] }))).toBe(false)
    expect(isTypeVisible(typeNote('Shown', { visible: 'False' }))).toBe(true)
    const booleanHidden = typeNote('Hidden')
    booleanHidden.properties = { ...booleanHidden.properties, visible: false as unknown as string }
    expect(isTypeVisible(booleanHidden)).toBe(false)
  })

  it('uses _sidebar_label and falls back to the title', () => {
    expect(typeSidebarLabel(typeNote('Project', { _sidebar_label: 'Projects' }))).toBe('Projects')
    expect(typeSidebarLabel(typeNote('Project', { _sidebar_label: '  ' }))).toBe('Project')
    expect(typeSidebarLabel(typeNote('Project', { _sidebar_label: ['People'] }))).toBe('People')
    expect(typeSidebarLabel(typeNote('Project'))).toBe('Project')
  })

  it('places a new type one step after the current max', () => {
    const notes = [
      typeNote('Note', { _order: '10' }),
      typeNote('Project', { _order: '20' }),
      typeNote('Person', { _order: '30' }),
      { ...typeNote('Loose', { _order: '99' }), type: 'note' },
      typeNote('Broken', { _order: 'later' }),
    ]
    expect(nextTypeOrder(notes)).toBe('31')
    expect(nextTypeOrder([])).toBe('1')
  })

  it('turns a non-empty template string into one paragraph and no heading', () => {
    expect(templateBody(undefined)).toBeNull()
    expect(templateBody('')).toBeNull()
    expect(templateBody('   ')).toBeNull()
    expect(templateBody(['Bring a pencil.'])).toBeNull()
    expect(templateBody('Bring a pencil.')).toEqual({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Bring a pencil.' }] }],
    })
  })
})
