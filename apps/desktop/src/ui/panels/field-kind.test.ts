import type { StrideNote } from '@stride/core/note'
import { describe, expect, it } from 'vitest'
import { collectStatusValues, collectTags, fieldKindOf, statusTone } from './field-kind'

function note(properties: StrideNote['properties']): StrideNote {
  return { id: 'x', title: 'X', type: 'note', properties, doc: { type: 'doc', content: [] } }
}

describe('fieldKindOf', () => {
  it('keeps storage kinds for booleans, numbers and plain values', () => {
    expect(fieldKindOf('done', true)).toBe('boolean')
    expect(fieldKindOf('count', 12)).toBe('number')
    expect(fieldKindOf('owner', 'me')).toBe('text')
    expect(fieldKindOf('reviewers', ['a', 'b'])).toBe('list')
  })

  it('types the status property regardless of its value', () => {
    expect(fieldKindOf('status', 'draft')).toBe('status')
    expect(fieldKindOf('Status', 'anything')).toBe('status')
    expect(fieldKindOf('status', '')).toBe('status')
  })

  it('types date by name or by YYYY-MM-DD value shape', () => {
    expect(fieldKindOf('date', '2026-10-24')).toBe('date')
    expect(fieldKindOf('date', '')).toBe('date')
    expect(fieldKindOf('due', '2026-01-01')).toBe('date')
    expect(fieldKindOf('due', 'next week')).toBe('text')
    expect(fieldKindOf('date', 'next week')).toBe('text')
    expect(fieldKindOf('due', '2026-1-1')).toBe('text')
  })

  it('types tags by name and links by name or all-wikilink items', () => {
    expect(fieldKindOf('tags', ['a'])).toBe('tags')
    expect(fieldKindOf('tags', [])).toBe('tags')
    expect(fieldKindOf('links', [])).toBe('links')
    expect(fieldKindOf('see also', ['[[Note A]]', '[[Note B]]'])).toBe('links')
    expect(fieldKindOf('see also', ['[[Note A]]', 'plain'])).toBe('list')
  })

  it('never overrides boolean or number storage kinds', () => {
    expect(fieldKindOf('status', true)).toBe('boolean')
    expect(fieldKindOf('date', 20261024)).toBe('number')
    expect(fieldKindOf('tags', 'a, b')).toBe('text')
  })
})

describe('statusTone', () => {
  it('maps known labels case-insensitively and falls back to muted', () => {
    expect(statusTone('Draft')).toBe('draft')
    expect(statusTone('草稿')).toBe('draft')
    expect(statusTone('in progress')).toBe('doing')
    expect(statusTone('已完成')).toBe('done')
    expect(statusTone('custom')).toBe('muted')
    expect(statusTone('')).toBe('muted')
  })
})

describe('collectTags / collectStatusValues', () => {
  it('aggregates, dedupes and sorts tags from lists and comma strings', () => {
    const notes = [
      note({ tags: ['beta', 'alpha'] }),
      note({ tags: 'gamma, alpha' }),
      note({ tags: ['', '  '] }),
      note({}),
    ]
    expect(collectTags(notes)).toEqual(['alpha', 'beta', 'gamma'])
  })

  it('aggregates status values from strings and lists', () => {
    const notes = [note({ status: 'draft' }), note({ status: 'doing' }), note({ status: ['doing'] }), note({})]
    expect(collectStatusValues(notes)).toEqual(['doing', 'draft'])
  })
})
