import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryFileSystem } from '@stride/platform'
import { buildGraph, relationsOf } from './graph.ts'
import {
  findMark,
  firstH1Text,
  formatProperty,
  headingText,
  isHiddenProperty,
  noteForSave,
  parseFiniteNumber,
  parseListInput,
  parseNote,
  parsePropertyInput,
  plainText,
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
})
