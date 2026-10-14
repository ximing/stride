import { createNote, type NoteProperty, type StrideNote } from '@stride/core/note'
import { describe, expect, it } from 'vitest'
import { resolve } from '@rabjs/react'
import { filterNotes } from './list-filter'
import { ListFilterService } from './list-filter.service'

function note(title: string, properties: Record<string, NoteProperty> = {}): StrideNote {
  const created = createNote(title.toLowerCase().replace(/\s+/g, '-'), title)
  created.properties = properties
  return created
}

describe('filterNotes', () => {
  const meeting = note('会议纪要', {
    status: '进行中',
    count: 12,
    pinned: true,
    tags: ['待办', 'Alpha'],
    _icon: 'secret-icon',
    _color: 'blue',
    _order: 4,
  })
  const shopping = note('Shopping List', { status: 'done', ready: false })
  const notes = [meeting, shopping]

  it('keeps the same list for an empty query', () => {
    expect(filterNotes(notes, '')).toBe(notes)
    expect(filterNotes(notes, '   ')).toBe(notes)
    expect(filterNotes(notes, '\n')).toBe(notes)
  })

  it('matches title substrings, including Chinese and case', () => {
    expect(filterNotes(notes, '纪要').map((item) => item.title)).toEqual(['会议纪要'])
    expect(filterNotes(notes, 'SHOP').map((item) => item.title)).toEqual(['Shopping List'])
    expect(filterNotes(notes, 'list').map((item) => item.title)).toEqual(['Shopping List'])
  })

  it('matches string, number, boolean, and list property values', () => {
    expect(filterNotes(notes, '进行').map((item) => item.title)).toEqual(['会议纪要'])
    expect(filterNotes(notes, '12').map((item) => item.title)).toEqual(['会议纪要'])
    expect(filterNotes(notes, 'TRUE').map((item) => item.title)).toEqual(['会议纪要'])
    expect(filterNotes(notes, 'false').map((item) => item.title)).toEqual(['Shopping List'])
    expect(filterNotes(notes, '待办').map((item) => item.title)).toEqual(['会议纪要'])
    expect(filterNotes(notes, 'alpha').map((item) => item.title)).toEqual(['会议纪要'])
    expect(filterNotes(notes, 'o,b')).toEqual([])
  })

  it('ignores system properties that start with _', () => {
    expect(filterNotes(notes, 'secret')).toEqual([])
    expect(filterNotes(notes, 'blue')).toEqual([])
    expect(filterNotes(notes, '4')).toEqual([])
    expect(filterNotes([note('Plain', { _icon: '纪要' })], '纪要')).toEqual([])
  })

  it('does not match property keys, ids, or body text', () => {
    const body = note('Untitled', { status: 'x' })
    body.id = '会议纪要'
    body.doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '进行中' }] }] }
    expect(filterNotes([body], 'status')).toEqual([])
    expect(filterNotes([body], '会议')).toEqual([])
    expect(filterNotes([body], '进行')).toEqual([])
    expect(filterNotes([body], 'x').map((item) => item.id)).toEqual(['会议纪要'])
  })
})

describe('ListFilterService', () => {
  it('applies the query immediately and clears back to the same list', () => {
    const service = resolve(ListFilterService)
    service.clear()
    const notes = [note('会议纪要', { status: '进行中' }), note('Other')]
    expect(service.apply(notes)).toBe(notes)
    service.setQuery('进行')
    expect(service.apply(notes).map((item) => item.title)).toEqual(['会议纪要'])
    service.clear()
    expect(service.query).toBe('')
    expect(service.apply(notes)).toBe(notes)
  })
})
