import { MemoryFileSystem } from '@stride/platform'
import { createNote, type StrideNote } from './note.ts'
import { describe, expect, it } from 'vitest'
import {
  applyViewFilter,
  applyViewsOrder,
  dedupeViewSlug,
  listViews,
  matchesPropertyFilter,
  moveViewBefore,
  parseViewFile,
  readViewsOrder,
  sanitizeView,
  serializeView,
  viewFilePath,
  viewSlug,
  VIEWS_ORDER_PATH,
  writeViewFile,
  writeViewsOrder,
  type SavedView,
} from './views.ts'

function note(id: string, title: string, properties: StrideNote['properties'] = {}, type = 'note'): StrideNote {
  return { ...createNote(id, title), type, properties }
}

function view(partial: Partial<SavedView> & { name: string }): SavedView {
  return { version: 1, ...partial }
}

describe('sanitizeView', () => {
  it('accepts a full view and drops unknown fields', () => {
    const raw = {
      version: 1,
      name: '  Reading  ',
      icon: '📚',
      type: 'Article',
      propertyFilters: [{ key: 'status', op: 'eq', value: 'reading' }],
      sort: { key: 'title', dir: 'asc' },
      archived: true,
      futureField: { nested: true },
    }
    const parsed = sanitizeView(raw)
    expect(parsed).toEqual({
      version: 1,
      name: 'Reading',
      icon: '📚',
      type: 'Article',
      propertyFilters: [{ key: 'status', op: 'eq', value: 'reading' }],
      sort: { key: 'title', dir: 'asc' },
      archived: true,
    })
    expect(JSON.stringify(parsed)).not.toContain('futureField')
  })

  it('rejects garbage, wrong versions, and empty names', () => {
    expect(sanitizeView(null)).toBeNull()
    expect(sanitizeView('view')).toBeNull()
    expect(sanitizeView([])).toBeNull()
    expect(sanitizeView({ version: 2, name: 'Future' })).toBeNull()
    expect(sanitizeView({ version: '1', name: 'Stringy' })).toBeNull()
    expect(sanitizeView({ version: 1 })).toBeNull()
    expect(sanitizeView({ version: 1, name: '   ' })).toBeNull()
  })

  it('drops invalid optional fields individually', () => {
    const parsed = sanitizeView({
      version: 1,
      name: 'Loose',
      icon: 42,
      type: '',
      sort: { key: 'bogus', dir: 'asc' },
      archived: 'yes',
      propertyFilters: [
        { key: '', op: 'eq', value: 'x' },
        { key: 'status', op: 'bogus', value: 'x' },
        { key: 'status', op: 'eq' },
        { key: 'status', op: 'contains', value: 7 },
        { key: 'due', op: 'exists', value: 'ignored' },
        'not-an-object',
      ],
    })
    expect(parsed).toEqual({
      version: 1,
      name: 'Loose',
      propertyFilters: [
        { key: 'status', op: 'contains', value: '7' },
        { key: 'due', op: 'exists' },
      ],
    })
  })
})

describe('serializeView / parseViewFile', () => {
  it('round-trips and keeps a stable key order', () => {
    const source = view({
      name: 'Reading',
      icon: '📚',
      type: 'Article',
      propertyFilters: [
        { key: 'status', op: 'eq', value: 'reading' },
        { key: 'due', op: 'exists' },
      ],
      sort: { key: 'created', dir: 'desc' },
      archived: true,
    })
    const text = serializeView(source)
    expect(text.endsWith('\n')).toBe(true)
    expect(text.indexOf('"version"')).toBeLessThan(text.indexOf('"name"'))
    expect(text.indexOf('"name"')).toBeLessThan(text.indexOf('"propertyFilters"'))
    expect(parseViewFile(text)).toEqual(source)
  })

  it('omits empty optionals and the exists value', () => {
    const text = serializeView(view({ name: 'Plain', propertyFilters: [{ key: 'due', op: 'exists' }] }))
    expect(text).not.toContain('"icon"')
    expect(text).not.toContain('"type"')
    expect(text).not.toContain('"sort"')
    expect(text).not.toContain('"archived"')
    expect(text).not.toContain('"value"')
  })

  it('returns null for unreadable JSON instead of throwing', () => {
    expect(parseViewFile('')).toBeNull()
    expect(parseViewFile('not json {')).toBeNull()
    expect(parseViewFile('[1,2]')).toBeNull()
    expect(parseViewFile('{"version":9,"name":"x"}')).toBeNull()
  })
})

describe('viewSlug / dedupeViewSlug', () => {
  it('slugifies like note ids, with a view fallback', () => {
    expect(viewSlug('Reading List')).toBe('reading-list')
    expect(viewSlug('  待读 队列  ')).toBe('待读-队列')
    expect(viewSlug('!!!')).toBe('view')
    expect(viewSlug('')).toBe('view')
  })

  it('dedupes against taken slugs', () => {
    expect(dedupeViewSlug('reading', new Set())).toBe('reading')
    expect(dedupeViewSlug('reading', new Set(['reading']))).toBe('reading-2')
    expect(dedupeViewSlug('reading', new Set(['reading', 'reading-2']))).toBe('reading-3')
  })
})

describe('view file io', () => {
  it('writes, lists, and tolerates garbage siblings', async () => {
    const fs = new MemoryFileSystem()
    expect(await listViews(fs)).toEqual([])
    await writeViewFile(fs, 'reading', view({ name: 'Reading', type: 'Article' }))
    await writeViewFile(fs, 'errands', view({ name: 'Errands' }))
    await fs.writeText(viewFilePath('broken'), '{not json')
    await fs.writeText(viewFilePath('old'), JSON.stringify({ version: 2, name: 'Old' }))
    await fs.writeText('views/.hidden.json', JSON.stringify({ version: 1, name: 'Hidden' }))
    await fs.writeText('views/readme.txt', 'not a view')
    const views = await listViews(fs)
    expect(views.map((item) => item.file).sort()).toEqual(['errands', 'reading'])
    expect(views.find((item) => item.file === 'reading')?.view.name).toBe('Reading')
  })

  it('reads and writes the order file with sanitizing', async () => {
    const fs = new MemoryFileSystem()
    expect(await readViewsOrder(fs)).toEqual([])
    await writeViewsOrder(fs, ['b', 'a'])
    expect(await readViewsOrder(fs)).toEqual(['b', 'a'])
    const raw = JSON.parse(await fs.readText(VIEWS_ORDER_PATH)) as { version: number }
    expect(raw.version).toBe(1)
    await fs.writeText(VIEWS_ORDER_PATH, '{broken')
    expect(await readViewsOrder(fs)).toEqual([])
    await fs.writeText(VIEWS_ORDER_PATH, JSON.stringify({ version: 1, order: ['a', 'a', 3, '', 'b'] }))
    expect(await readViewsOrder(fs)).toEqual(['a', 'b'])
    await fs.writeText(VIEWS_ORDER_PATH, JSON.stringify({ version: 2, order: ['a'] }))
    expect(await readViewsOrder(fs)).toEqual([])
  })
})

describe('applyViewsOrder / moveViewBefore', () => {
  const loaded = [
    { file: 'c', view: view({ name: 'Charlie' }) },
    { file: 'a', view: view({ name: 'Alpha' }) },
    { file: 'b', view: view({ name: 'Beta' }) },
  ]

  it('orders by the order file, appending unknown views by name and ignoring stale slugs', () => {
    expect(applyViewsOrder(loaded, ['b', 'stale']).map((item) => item.file)).toEqual(['b', 'a', 'c'])
    expect(applyViewsOrder(loaded, []).map((item) => item.file)).toEqual(['a', 'b', 'c'])
  })

  it('moves a dragged slug before the target', () => {
    expect(moveViewBefore(['a', 'b', 'c'], 'c', 'a')).toEqual(['c', 'a', 'b'])
    expect(moveViewBefore(['a', 'b', 'c'], 'a', 'c')).toEqual(['b', 'a', 'c'])
    expect(moveViewBefore(['a', 'b', 'c'], 'a', 'a')).toEqual(['a', 'b', 'c'])
    expect(moveViewBefore(['a', 'b', 'c'], 'x', 'a')).toEqual(['a', 'b', 'c'])
    expect(moveViewBefore(['a', 'b', 'c'], 'a', 'x')).toEqual(['a', 'b', 'c'])
  })
})

describe('matchesPropertyFilter', () => {
  const target = note('n', 'N', {
    status: 'Reading',
    rating: 4,
    done: false,
    tags: ['Books', 'Sci-Fi'],
  })

  it('exists only checks presence', () => {
    expect(matchesPropertyFilter(target, { key: 'status', op: 'exists' })).toBe(true)
    expect(matchesPropertyFilter(target, { key: 'missing', op: 'exists' })).toBe(false)
  })

  it('eq matches strings case-insensitively, numbers numerically, booleans, and list items', () => {
    expect(matchesPropertyFilter(target, { key: 'status', op: 'eq', value: 'reading' })).toBe(true)
    expect(matchesPropertyFilter(target, { key: 'status', op: 'eq', value: 'read' })).toBe(false)
    expect(matchesPropertyFilter(target, { key: 'rating', op: 'eq', value: '4' })).toBe(true)
    expect(matchesPropertyFilter(target, { key: 'rating', op: 'eq', value: '4.5' })).toBe(false)
    expect(matchesPropertyFilter(target, { key: 'done', op: 'eq', value: 'false' })).toBe(true)
    expect(matchesPropertyFilter(target, { key: 'done', op: 'eq', value: 'true' })).toBe(false)
    expect(matchesPropertyFilter(target, { key: 'tags', op: 'eq', value: 'books' })).toBe(true)
    expect(matchesPropertyFilter(target, { key: 'missing', op: 'eq', value: 'x' })).toBe(false)
    expect(matchesPropertyFilter(target, { key: 'status', op: 'eq', value: '' })).toBe(false)
  })

  it('contains matches substrings on strings, numbers, and list items', () => {
    expect(matchesPropertyFilter(target, { key: 'status', op: 'contains', value: 'read' })).toBe(true)
    expect(matchesPropertyFilter(target, { key: 'rating', op: 'contains', value: '4' })).toBe(true)
    expect(matchesPropertyFilter(target, { key: 'tags', op: 'contains', value: 'sci' })).toBe(true)
    expect(matchesPropertyFilter(target, { key: 'tags', op: 'contains', value: 'fantasy' })).toBe(false)
    expect(matchesPropertyFilter(target, { key: 'missing', op: 'contains', value: 'x' })).toBe(false)
  })
})

describe('applyViewFilter', () => {
  const notes = [
    note('a', 'Alpha', { status: 'reading' }, 'Article'),
    note('b', 'Beta', { status: 'done' }, 'Article'),
    note('c', 'Gamma', { status: 'reading' }, 'note'),
    note('d', 'Delta', { archived: true, status: 'reading' }, 'Article'),
    note('t', 'Types', {}, 'Type'),
  ]

  it('filters by type and property, hiding Type docs and archived notes by default', () => {
    const reading = view({
      name: 'Reading',
      type: 'Article',
      propertyFilters: [{ key: 'status', op: 'eq', value: 'reading' }],
    })
    expect(applyViewFilter(notes, reading).map((item) => item.id)).toEqual(['a'])
  })

  it('opts into archived notes with archived: true', () => {
    const withArchived = view({ name: 'All reading', archived: true, propertyFilters: [{ key: 'status', op: 'eq', value: 'reading' }] })
    expect(applyViewFilter(notes, withArchived).map((item) => item.id)).toEqual(['a', 'c', 'd'])
  })

  it('AND-combines multiple property filters', () => {
    const both = view({
      name: 'Both',
      propertyFilters: [
        { key: 'status', op: 'contains', value: 'read' },
        { key: 'status', op: 'exists' },
      ],
    })
    expect(applyViewFilter(notes, both).map((item) => item.id)).toEqual(['a', 'c'])
  })

  it('matches everything (except Type docs and archived) with no conditions', () => {
    expect(applyViewFilter(notes, view({ name: 'Open' })).map((item) => item.id)).toEqual(['a', 'b', 'c'])
  })
})
