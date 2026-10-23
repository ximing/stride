import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryFileSystem } from '@stride/platform'
import { buildGraph, relationsOf } from './graph.ts'
import {
  applyBody,
  bodyWikilinks,
  createNote,
  findMark,
  firstH1Text,
  formatProperty,
  headingText,
  isArchived,
  isHiddenProperty,
  noteForSave,
  parseFiniteNumber,
  parseListInput,
  parseNote,
  parsePropertyInput,
  plainText,
  plainWikilinks,
  splitWikilinkText,
  wikilinkTargets,
  type TipTapNode,
} from './note.ts'
import { createVaultNote, nextSlugId, notePath, openVault, readNoteFile, saveNote } from './vault.ts'

const filesystems: MemoryFileSystem[] = []

function vault(label: string): MemoryFileSystem {
  const fs = new MemoryFileSystem(label)
  filesystems.push(fs)
  return fs
}

afterEach(() => {
  filesystems.splice(0)
})

describe('note codec', () => {
  it('saves TipTap JSON and reopens the same title, text, mark, type, and status', async () => {
    const files = vault('/tmp/stride-note')
    const doc: TipTapNode = {
      type: 'doc',
      content: [
        {
          type: 'heading',
          attrs: { level: 1 },
          content: [{ type: 'text', text: 'Round Trip' }],
        },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'A ' },
            { type: 'text', text: 'bold span', marks: [{ type: 'bold' }] },
            { type: 'text', text: ' stays.' },
          ],
        },
      ],
    }
    const written = await saveNote(files, {
      id: 'round-trip',
      title: 'Round Trip',
      type: 'essay',
      properties: { status: 'draft' },
      doc,
    })
    const raw = await files.readText('round-trip.stride.json')
    expect(raw.trimStart().startsWith('---')).toBe(false)
    const parsed = JSON.parse(raw) as { format: string; doc: TipTapNode }
    expect(parsed.format).toBe('tiptap')
    expect(parsed.doc.type).toBe('doc')

    const opened = await openVault(files, '/home/tester')
    expect(opened.notes).toHaveLength(1)
    const loaded = opened.notes[0]!
    expect(loaded).toEqual(written)
    expect(loaded.title).toBe('Round Trip')
    expect(loaded.type).toBe('essay')
    expect(loaded.properties.status).toBe('draft')
    expect(headingText(loaded.doc)).toBe('Round Trip')
    expect(plainText(loaded.doc)).toContain('bold span')
    expect(findMark(loaded.doc, 'bold')?.text).toBe('bold span')
    expect(await files.stat('.git')).toBeNull()

    const direct = await readNoteFile(files, 'round-trip.stride.json', 'round-trip')
    expect(direct.title).toBe('Round Trip')
    expect(direct.properties.status).toBe('draft')
  })

  it('opens the vault when one note file is a git conflict and leaves that file untouched', async () => {
    const files = vault('/tmp/stride-conflict-note')
    await saveNote(files, {
      id: 'ok',
      title: 'Ok',
      type: 'note',
      properties: {},
      doc: { type: 'doc', content: [{ type: 'paragraph' }] },
    })
    const conflict = '<<<<<<< HEAD\nnot json\n=======\ntheirs\n>>>>>>> abc\n'
    await files.writeText('untitled-nbz2.stride.json', conflict)
    const opened = await openVault(files, '/home/tester')
    expect(opened.notes.map((note) => note.id)).toEqual(['ok'])
    expect(await files.readText('untitled-nbz2.stride.json')).toBe(conflict)
  })

  it('keeps a spaced wikilink intact and does not rewrite a partial [[', async () => {
    let shown = ''
    for (const ch of '[[Parent]]') {
      shown = formatProperty(parsePropertyInput(shown + ch))
    }
    expect(shown).toBe('[[Parent]]')
    expect(formatProperty(parsePropertyInput('[['))).toBe('[[')
    expect(formatProperty(parsePropertyInput('[[Other'))).toBe('[[Other')

    const files = vault('/tmp/stride-note-links')
    const parent = await saveNote(files, {
      id: 'other-note',
      title: 'Other note',
      type: 'note',
      properties: {},
      doc: { type: 'doc', content: [{ type: 'paragraph' }] },
    })
    const child = await saveNote(files, {
      id: 'child',
      title: 'Child',
      type: 'note',
      properties: { belongs_to: parsePropertyInput('[[Other note]]') },
      doc: { type: 'doc', content: [{ type: 'paragraph' }] },
    })
    expect(formatProperty(child.properties.belongs_to)).toBe('[[Other note]]')
    const graph = buildGraph([parent, child])
    expect(relationsOf(graph, 'child').shown.some((link) => link.field === 'belongs_to' && link.targetId === 'other-note')).toBe(true)
    expect(relationsOf(graph, 'other-note').shown.some((link) => link.field === 'has' && link.targetId === 'child' && link.derived)).toBe(true)
  })

  it('keeps number, boolean, and list values and drops nulls and objects', async () => {
    const doc: TipTapNode = { type: 'doc', content: [{ type: 'paragraph' }] }
    const files = vault('/tmp/stride-typed-props')
    await saveNote(files, {
      id: 'typed',
      title: 'Typed',
      type: 'note',
      properties: {
        count: 0,
        done: false,
        tags: ['alpha', '[[Other note]]'],
        label: 'solo',
      },
      doc,
    })
    const stored = JSON.parse(await files.readText('typed.stride.json')) as { properties: Record<string, unknown> }
    expect(stored.properties.count).toBe(0)
    expect(typeof stored.properties.count).toBe('number')
    expect(stored.properties.done).toBe(false)
    expect(typeof stored.properties.done).toBe('boolean')
    expect(stored.properties.tags).toEqual(['alpha', '[[Other note]]'])

    const loaded = parseNote(JSON.stringify({
      format: 'tiptap',
      title: 'Typed',
      type: 'note',
      properties: {
        count: 4,
        done: true,
        tags: ['a', 'b'],
        label: '12',
        nested: { no: true },
        missing: null,
        mixed: ['a', 1],
        objectList: [{ name: 'x' }],
      },
      doc,
    }), 'typed')
    expect(loaded.properties).toEqual({
      count: 4,
      done: true,
      tags: ['a', 'b'],
      label: '12',
    })
    expect(parseNote(JSON.stringify({
      format: 'tiptap',
      title: 'Empty',
      type: 'note',
      properties: null,
      doc,
    }), 'empty').properties).toEqual({})

    expect(isHiddenProperty('_icon')).toBe(true)
    expect(isHiddenProperty('_color')).toBe(true)
    expect(isHiddenProperty('_order')).toBe(true)
    expect(isHiddenProperty('_sidebar_label')).toBe(true)
    expect(isHiddenProperty('_secret')).toBe(true)
    expect(isHiddenProperty('template')).toBe(false)
    expect(isHiddenProperty('visible')).toBe(false)

    expect(parsePropertyInput('solo')).toBe('solo')
    expect(Array.isArray(parsePropertyInput('[['))).toBe(false)
    expect(formatProperty(parsePropertyInput('[['))).toBe('[[')
    expect(formatProperty(parsePropertyInput('[[Other'))).toBe('[[Other')
    expect(parsePropertyInput('[[A]] [[B]]')).toEqual(['[[A]]', '[[B]]'])
    expect(parseListInput('solo')).toEqual(['solo'])
    expect(parseListInput('[[Other note]] plain')).toEqual(['[[Other note]]', 'plain'])
    expect(parseFiniteNumber('12')).toBe(12)
    expect(parseFiniteNumber('1.')).toBeUndefined()
    expect(parseFiniteNumber('1e309')).toBeUndefined()
    expect(parseFiniteNumber('true')).toBeUndefined()
    expect(formatProperty(false)).toBe('false')
    expect(formatProperty(0)).toBe('0')
  })

  it('treats true and the string true as archived', () => {
    const properties = (archived?: unknown) => (archived === undefined ? {} : { archived })
    expect(isArchived({ properties: properties(true) })).toBe(true)
    expect(isArchived({ properties: properties('true') })).toBe(true)
    expect(isArchived({ properties: properties(false) })).toBe(false)
    expect(isArchived({ properties: properties() })).toBe(false)
    expect(isArchived({ properties: properties('false') })).toBe(false)
  })

  it('refuses a note id that escapes the vault', async () => {
    const files = vault('/tmp/stride-note-escape')
    const note = {
      title: 'Escape',
      type: 'note',
      properties: {},
      doc: { type: 'doc' as const, content: [{ type: 'paragraph' }] },
    }
    await expect(saveNote(files, { ...note, id: '../outside' })).rejects.toThrow(/escapes the vault|Invalid note id/)
    await expect(saveNote(files, { ...note, id: 'foo/../../outside' })).rejects.toThrow(/escapes the vault|Invalid note id/)
    expect(await files.stat('outside.stride.json')).toBeNull()
    expect(notePath('inside')).toBe('inside.stride.json')
    await expect(files.stat('../outside.stride.json')).rejects.toThrow(/escape/i)
  })

  it('reads the first H1 and ignores earlier headings of other levels', () => {
    const doc: TipTapNode = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Not the title' }] },
        { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Real title' }] },
        { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Later' }] },
      ],
    }
    expect(firstH1Text(doc)).toBe('Real title')
    expect(headingText(doc)).toBe('Not the title')
    expect(firstH1Text({
      type: 'doc',
      content: [{ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Only a subhead' }] }],
    })).toBe('')
  })

  it('lets a leading H1 win over a stale title and does not double an existing H1', () => {
    const doc: TipTapNode = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Fresh' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'body' }] },
      ],
    }
    const raw = JSON.stringify({
      format: 'tiptap',
      title: 'Stale',
      type: 'note',
      properties: {},
      doc,
    })
    expect(parseNote(raw, 'fresh').title).toBe('Fresh')
    const kept = parseNote(JSON.stringify({
      format: 'tiptap',
      title: 'Kept',
      type: 'note',
      properties: {},
      doc: {
        type: 'doc',
        content: [
          { type: 'paragraph' },
          { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Later' }] },
        ],
      },
    }), 'kept')
    expect(kept.title).toBe('Kept')
    expect(firstH1Text(kept.doc)).toBe('Later')

    const prepared = noteForSave({
      id: 'round-trip',
      title: 'Fresh',
      type: 'note',
      properties: {},
      doc,
    })
    expect(prepared.doc.content?.filter((node) => node.type === 'heading')).toHaveLength(1)
    expect(plainText(prepared.doc.content?.[0] ?? { type: 'doc' })).toBe('Fresh')
    expect(prepared.doc.content?.[1]).toEqual(doc.content?.[1])
  })

  it('keeps a mark, a wikilink, and math when applyBody promotes the leading heading', async () => {
    const heading: TipTapNode = {
      type: 'heading',
      attrs: { level: 1 },
      content: [
        { type: 'text', text: 'See ', marks: [{ type: 'bold' }] },
        { type: 'wikilink', attrs: { target: 'Mass', alias: 'm' } },
        { type: 'text', text: ' ' },
        { type: 'inlineMath', attrs: { latex: 'E=mc^2' } },
      ],
    }
    const paragraph: TipTapNode = { type: 'paragraph', content: [{ type: 'text', text: 'body' }] }
    const applied = applyBody('Stale', { type: 'doc', content: [heading, paragraph] })
    expect(applied.lifted).toBe(true)
    expect(applied.title).toBe('See Mass')
    expect(applied.doc.content?.[0]).toEqual(heading)
    expect(applied.doc.content?.[0]?.content).not.toEqual([{ type: 'text', text: 'See Mass' }])
    expect(applied.doc.content?.[1]).toEqual(paragraph)
    expect(findMark(applied.doc, 'bold')?.text).toBe('See ')

    const files = vault('/tmp/stride-promote-heading')
    const saved = await saveNote(files, noteForSave({
      id: 'promoted',
      title: applied.title,
      type: 'note',
      properties: { status: 'draft' },
      doc: applied.doc,
    }))
    expect(saved.title).toBe('See Mass')
    expect(saved.type).toBe('note')
    expect(saved.properties.status).toBe('draft')
    expect(saved.doc.content?.[0]).toEqual(heading)
    expect(saved.doc.content?.[1]).toEqual(paragraph)
    const raw = JSON.parse(await files.readText('promoted.stride.json')) as {
      format: string
      title: string
      doc: TipTapNode
    }
    expect(raw.format).toBe('tiptap')
    expect(raw.title).toBe('See Mass')
    expect(raw.doc.type).toBe('doc')
    expect(raw.doc.content?.[0]).toEqual(heading)
  })

  it('splits a plain-text wikilink alias and leaves a bare link unchanged', () => {
    expect(splitWikilinkText('标题|别名')).toEqual({ target: '标题', alias: '别名' })
    expect(splitWikilinkText('标题')).toEqual({ target: '标题', alias: '' })
    expect(plainWikilinks('[[标题|别名]]')).toEqual([
      { target: '标题', alias: '别名', start: 0, end: '[[标题|别名]]'.length },
    ])
    expect(plainWikilinks('[[ 标题 | 别名 | 更多 ]]')).toEqual([
      { target: '标题', alias: '别名 | 更多', start: 0, end: '[[ 标题 | 别名 | 更多 ]]'.length },
    ])
    expect(wikilinkTargets('[[标题|别名]]')).toEqual(['标题'])
    expect(wikilinkTargets('[[标题]]')).toEqual(['标题'])
    expect(wikilinkTargets('[[  标题  ]]')).toEqual(['标题'])
    expect(wikilinkTargets('见 [[ A | B ]] 与 [[C]]')).toEqual(['A', 'C'])
    expect(wikilinkTargets(['[[标题|别名]]', '[[标题]]'])).toEqual(['标题', '标题'])
    expect(wikilinkTargets('[[|别名]]')).toEqual([])
    expect(plainWikilinks('[[|别名]]')).toEqual([])

    const doc: TipTapNode = {
      type: 'doc',
      content: [{
        type: 'paragraph',
        content: [
          { type: 'text', text: '[[标题|别名]] [[标题]]' },
          { type: 'wikilink', attrs: { target: '节点', alias: '显示' } },
        ],
      }],
    }
    expect(bodyWikilinks(doc)).toEqual(['标题', '标题', '节点'])
    expect(doc.content?.[0]?.content?.[0]?.text).toBe('[[标题|别名]] [[标题]]')
  })

  it('allocates untitled-xxxx, retries collisions, and keeps a real title slug', async () => {
    const files = vault('/tmp/stride-untitled')
    const scripted = [
      [0, 0, 0, 0],
      [1, 2, 3, 4],
    ]
    let call = 0
    const spy = vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation((array) => {
      const view = new Uint8Array(array.buffer, array.byteOffset, array.byteLength)
      const bytes = scripted[Math.min(call, scripted.length - 1)] ?? []
      call += 1
      for (let i = 0; i < view.length; i += 1) view[i] = bytes[i] ?? 0
      return array
    })
    try {
      await files.writeText('untitled-0000.stride.json', '{}\n')
      const note = await createVaultNote(files)
      expect(call).toBeGreaterThanOrEqual(2)
      expect(note.id).toBe('untitled-1234')
      expect(note.title).toBe('Untitled')
      expect(note.doc.content?.some((node) => node.type === 'heading')).toBe(false)
      expect(await files.stat('untitled-1234.stride.json')).not.toBeNull()
    } finally {
      spy.mockRestore()
    }

    const blank = await createVaultNote(files, ' ')
    expect(blank.id).toMatch(/^untitled-[a-z0-9]{4}$/)
    expect(blank.id).not.toBe('untitled-0000')
    expect(blank.title).toBe('Untitled')
    const alias = await createVaultNote(files, 'untitled')
    expect(alias.id).toMatch(/^untitled-[a-z0-9]{4}$/)
    expect(alias.title).toBe('Untitled')

    const status = await createVaultNote(files, 'Status')
    expect(status.id).toBe('status')
  })

  it('suffixes a rename when the slug is taken and skips the current file', async () => {
    const files = vault('/tmp/stride-rename')
    const status = await createVaultNote(files, 'Status')
    expect(status.id).toBe('status')
    expect(await nextSlugId(files, 'Status', status.id)).toBe('status')
    const other = await createVaultNote(files, 'Other')
    expect(await nextSlugId(files, 'Status', other.id)).toBe('status-2')
    const second = await createVaultNote(files, 'Status')
    expect(second.id).toBe('status-2')
    expect(await nextSlugId(files, 'Status', 'status-2')).toBe('status-2')
    expect(await nextSlugId(files, 'Status', 'fresh')).toBe('status-3')
  })

  it('keeps the directory prefix and suffixes only inside that directory', async () => {
    const files = vault('/tmp/stride-folder-slug')
    await saveNote(files, createNote('status', 'Status'))
    await saveNote(files, createNote('box/status', 'Status'))
    await saveNote(files, createNote('box/status-2', 'Status'))
    await saveNote(files, createNote('box/inner/other', 'Other'))

    expect(await nextSlugId(files, 'Status', 'box/status')).toBe('box/status')
    expect(await nextSlugId(files, 'Status', 'box/other')).toBe('box/status-3')
    expect(await nextSlugId(files, 'Fresh Title', 'box/other')).toBe('box/fresh-title')
    expect(await nextSlugId(files, 'Status', 'box/inner/other')).toBe('box/inner/status')
    expect(await nextSlugId(files, 'Status', 'other')).toBe('status-2')
    expect(await nextSlugId(files, 'Status', 'crate/other')).toBe('crate/status')
  })
})
