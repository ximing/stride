import { afterEach, describe, expect, it } from 'vitest'
import { MemoryFileSystem } from '@stride/platform'
import { buildGraph, relationsOf } from './graph.ts'
import { findMark, formatProperty, headingText, parsePropertyInput, plainText, type TipTapNode } from './note.ts'
import { notePath, openVault, readNoteFile, saveNote } from './vault.ts'

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
})
