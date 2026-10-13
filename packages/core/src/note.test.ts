import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildGraph, relationsOf } from './graph.ts'
import { findMark, formatProperty, headingText, parsePropertyInput, plainText, type TipTapNode } from './note.ts'
import { openVault, readNoteFile, saveNote } from './vault.ts'

const dirs: string[] = []

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stride-note-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('note codec', () => {
  it('saves TipTap JSON and reopens the same title, text, mark, type, and status', () => {
    const vault = tempDir()
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
    const written = saveNote(vault, {
      id: 'round-trip',
      title: 'Round Trip',
      type: 'essay',
      properties: { status: 'draft' },
      doc,
    })
    const file = path.join(vault, 'round-trip.stride.json')
    const raw = fs.readFileSync(file, 'utf8')
    expect(raw.trimStart().startsWith('---')).toBe(false)
    const parsed = JSON.parse(raw) as { format: string; doc: TipTapNode }
    expect(parsed.format).toBe('tiptap')
    expect(parsed.doc.type).toBe('doc')

    const opened = openVault(vault)
    expect(opened.notes).toHaveLength(1)
    const loaded = opened.notes[0]!
    expect(loaded).toEqual(written)
    expect(loaded.title).toBe('Round Trip')
    expect(loaded.type).toBe('essay')
    expect(loaded.properties.status).toBe('draft')
    expect(headingText(loaded.doc)).toBe('Round Trip')
    expect(plainText(loaded.doc)).toContain('bold span')
    expect(findMark(loaded.doc, 'bold')?.text).toBe('bold span')
    expect(fs.existsSync(path.join(vault, '.git'))).toBe(false)

    const direct = readNoteFile(file, 'round-trip')
    expect(direct.title).toBe('Round Trip')
    expect(direct.properties.status).toBe('draft')
  })

  it('keeps a spaced wikilink intact and does not rewrite a partial [[', () => {
    let shown = ''
    for (const ch of '[[Parent]]') {
      shown = formatProperty(parsePropertyInput(shown + ch))
    }
    expect(shown).toBe('[[Parent]]')
    expect(formatProperty(parsePropertyInput('[['))).toBe('[[')
    expect(formatProperty(parsePropertyInput('[[Other'))).toBe('[[Other')

    const vault = tempDir()
    const parent = saveNote(vault, {
      id: 'other-note',
      title: 'Other note',
      type: 'note',
      properties: {},
      doc: { type: 'doc', content: [{ type: 'paragraph' }] },
    })
    const child = saveNote(vault, {
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

  it('refuses a note id that escapes the vault', () => {
    const vault = tempDir()
    const outside = path.resolve(vault, '..', 'outside.stride.json')
    const note = {
      title: 'Escape',
      type: 'note',
      properties: {},
      doc: { type: 'doc' as const, content: [{ type: 'paragraph' }] },
    }
    expect(() => saveNote(vault, { ...note, id: '../outside' })).toThrow(/escapes the vault|Invalid note id/)
    expect(() => saveNote(vault, { ...note, id: 'foo/../../outside' })).toThrow(/escapes the vault|Invalid note id/)
    expect(fs.existsSync(outside)).toBe(false)
    expect(fs.existsSync(path.resolve(vault, '..', '..', 'outside.stride.json'))).toBe(false)
  })
})
