import { describe, expect, it } from 'vitest'
import type { StrideNote } from './note.ts'
import {
  compareTypeDocuments,
  isTypeVisible,
  nextTypeOrder,
  resolveEntityColor,
  resolveTypeColor,
  templateBody,
  typeColorKey,
  typeSidebarLabel,
  typeSortOrder,
  TYPE_COLOR_KEYS,
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

  it('resolves type color: eight explicit colors win, gray/missing/unknown hash the title', () => {
    // The eight real colors win, case- and whitespace-insensitively.
    for (const color of TYPE_COLOR_KEYS) {
      if (color === 'gray') continue
      expect(resolveTypeColor('Project', color)).toBe(color)
    }
    expect(resolveTypeColor('Project', ' Blue ')).toBe('blue')

    // gray means "auto": it hashes like a missing or unknown value.
    const fallback = resolveTypeColor('Project')
    expect(fallback).not.toBe('gray')
    expect(TYPE_COLOR_KEYS).toContain(fallback)
    expect(resolveTypeColor('Project')).toBe(fallback)
    expect(resolveTypeColor('Project', 'gray')).toBe(fallback)
    expect(resolveTypeColor('Project', ' Gray ')).toBe(fallback)
    expect(resolveTypeColor('Project', 'lime')).toBe(fallback)
    expect(resolveTypeColor('Project', '  ')).toBe(fallback)

    // Case-insensitive titles hash to the same color.
    expect(resolveTypeColor('note')).toBe(resolveTypeColor('Note'))
    expect(resolveTypeColor('  Note  ')).toBe(resolveTypeColor('Note'))

    // Different titles spread across the palette (all non-gray).
    const colors = new Set(['Project', 'Person', 'Note', 'Journal', 'Book', 'Idea'].map((title) => resolveTypeColor(title)))
    expect(colors.has('gray')).toBe(false)
    expect(colors.size).toBeGreaterThan(1)
  })

  it('resolveEntityColor generalizes: explicit wins, gray/missing hash the name', () => {
    // Explicit real colors win; gray/auto and unknown values hash the name.
    expect(resolveEntityColor('alpha', 'blue')).toBe('blue')
    expect(resolveEntityColor('alpha', ' Teal ')).toBe('teal')
    const fallback = resolveEntityColor('alpha')
    expect(fallback).not.toBe('gray')
    expect(TYPE_COLOR_KEYS).toContain(fallback)
    expect(resolveEntityColor('alpha', 'gray')).toBe(fallback)
    expect(resolveEntityColor('alpha', 'auto')).toBe(fallback)
    expect(resolveEntityColor('alpha', 'lime')).toBe(fallback)

    // Same hash for tags and types: resolveTypeColor is a thin wrapper.
    expect(resolveEntityColor('Project')).toBe(resolveTypeColor('Project'))
    // Deterministic and case-insensitive for tag names.
    expect(resolveEntityColor('  Alpha ')).toBe(resolveEntityColor('alpha'))
  })

  it('reads the type color from the _color property of a document', () => {
    expect(typeColorKey(typeNote('Project', { _color: 'blue' }))).toBe('blue')
    expect(typeColorKey(typeNote('Project', { _color: ['Teal'] }))).toBe('teal')
    expect(typeColorKey(typeNote('Project'))).toBe(resolveTypeColor('Project'))
    expect(typeColorKey(typeNote('Project', { _color: 'lime' }))).toBe(resolveTypeColor('Project'))
    expect(typeColorKey(typeNote('Project', { _color: 'gray' }))).toBe(resolveTypeColor('Project'))
  })
})
