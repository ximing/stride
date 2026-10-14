import { Editor, type JSONContent } from '@tiptap/core'
import type { TipTapNode } from '@stride/core/note'
import { MemoryFileSystem } from '@stride/platform'
import fc from 'fast-check'
import { afterEach, describe, expect, it } from 'vitest'
import { saveNote } from '../../../../packages/core/src/vault'
import { createEditorExtensions } from './extensions'

const layoutBox = () => ({
  x: 0,
  y: 0,
  top: 0,
  left: 0,
  right: 1,
  bottom: 1,
  width: 1,
  height: 1,
  toJSON() {
    return {}
  },
})

if (typeof Range !== 'undefined' && typeof Range.prototype.getClientRects !== 'function') {
  Range.prototype.getClientRects = function getClientRects() {
    const list = [layoutBox()]
    return Object.assign(list, { item: (index: number) => list[index] ?? null }) as unknown as DOMRectList
  }
}
if (typeof Range !== 'undefined' && typeof Range.prototype.getBoundingClientRect !== 'function') {
  Range.prototype.getBoundingClientRect = function getBoundingClientRect() {
    return layoutBox() as DOMRect
  }
}

const editors: Editor[] = []

function createEditor(): Editor {
  const editor = new Editor({
    extensions: createEditorExtensions({ onModK: () => true, getFs: () => null }),
    content: { type: 'doc', content: [{ type: 'paragraph' }] },
  })
  editors.push(editor)
  return editor
}

afterEach(() => {
  editors.splice(0).forEach((editor) => editor.destroy())
})

async function roundTrip(editor: Editor, doc: JSONContent) {
  editor.commands.setContent(doc)
  const canonical = editor.getJSON()
  const fs = new MemoryFileSystem()
  const saved = await saveNote(fs, {
    id: 'round-trip',
    title: 'Round',
    type: 'note',
    properties: {},
    doc: canonical as TipTapNode,
  })
  editor.commands.setContent(saved.doc)
  expect(editor.getJSON()).toEqual(canonical)
  return canonical
}

function text(value: string, marks?: JSONContent['marks']): JSONContent {
  return marks ? { type: 'text', text: value, marks } : { type: 'text', text: value }
}

function paragraph(value: string, marks?: JSONContent['marks']): JSONContent {
  return { type: 'paragraph', content: [text(value, marks)] }
}

const mixed: JSONContent = {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 2 }, content: [text('Alpha')] },
    { type: 'heading', attrs: { level: 3 }, content: [text('Beta')] },
    { type: 'bulletList', content: [{ type: 'listItem', content: [paragraph('milk')] }] },
    { type: 'orderedList', content: [{ type: 'listItem', content: [paragraph('one')] }] },
    {
      type: 'taskList',
      content: [
        { type: 'taskItem', attrs: { checked: false }, content: [paragraph('open')] },
        { type: 'taskItem', attrs: { checked: true }, content: [paragraph('done')] },
      ],
    },
    { type: 'blockquote', content: [paragraph('quoted')] },
    { type: 'codeBlock', attrs: { language: 'typescript' }, content: [text('export const n = 1')] },
    { type: 'horizontalRule' },
    {
      type: 'table',
      content: [
        {
          type: 'tableRow',
          content: [
            { type: 'tableHeader', content: [paragraph('H1')] },
            { type: 'tableHeader', content: [paragraph('H2')] },
          ],
        },
        {
          type: 'tableRow',
          content: [
            { type: 'tableCell', content: [paragraph('A')] },
            { type: 'tableCell', content: [paragraph('B')] },
          ],
        },
      ],
    },
    { type: 'image', attrs: { src: 'attachments/a.png' } },
    { type: 'callout', attrs: { kind: 'warning' }, content: [paragraph('careful')] },
    {
      type: 'paragraph',
      content: [
        { type: 'wikilink', attrs: { target: 'Other note', alias: 'other' } },
        text(' '),
        { type: 'wikilink', attrs: { target: 'Plain', alias: null } },
      ],
    },
    paragraph('marked', [{ type: 'highlight' }, { type: 'bold' }, { type: 'link', attrs: { href: 'https://example.com' } }]),
  ],
}

describe('editor file round trip', () => {
  it('keeps every custom node through the note file', async () => {
    const editor = createEditor()
    const canonical = await roundTrip(editor, mixed)
    const blob = JSON.stringify(canonical)
    for (const type of ['heading', 'bulletList', 'orderedList', 'taskList', 'taskItem', 'blockquote', 'codeBlock', 'horizontalRule', 'table', 'image', 'callout', 'wikilink', 'highlight']) {
      expect(blob).toContain(`"${type}"`)
    }
    expect(blob).toContain('"checked":true')
    expect(blob).toContain('"language":"typescript"')
    expect(blob).toContain('"kind":"warning"')
    expect(blob).toContain('attachments/a.png')
    expect(blob).toContain('"alias":"other"')
  })

  it('round-trips random documents', async () => {
    const editor = createEditor()
    const word = fc.stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'), { minLength: 1, maxLength: 8 })
    const paragraphArb = word.map((value) => paragraph(value))
    const headingArb = fc.record({
      level: fc.constantFrom(2, 3),
      value: word,
    }).map(({ level, value }) => ({ type: 'heading', attrs: { level }, content: [text(value)] }))
    const taskArb = fc.record({ checked: fc.boolean(), value: word }).map(({ checked, value }) => ({
      type: 'taskList',
      content: [{ type: 'taskItem', attrs: { checked }, content: [paragraph(value)] }],
    }))
    const imageArb = word.map((value) => ({ type: 'image', attrs: { src: `attachments/${value}.png` } }))
    const calloutArb = fc.record({
      kind: fc.constantFrom('note', 'warning', 'tip'),
      value: word,
    }).map(({ kind, value }) => ({ type: 'callout', attrs: { kind }, content: [paragraph(value)] }))
    const codeArb = fc.record({
      language: fc.constantFrom('javascript', 'typescript', 'json', 'python', 'bash', 'xml', 'css', 'markdown'),
      value: word,
    }).map(({ language, value }) => ({ type: 'codeBlock', attrs: { language }, content: [text(value)] }))
    const linkArb = fc.record({
      target: word,
      alias: fc.option(word, { nil: null }),
    }).map(({ target, alias }) => ({
      type: 'paragraph',
      content: [{ type: 'wikilink', attrs: { target, alias } }],
    }))
    const highlightArb = word.map((value) => paragraph(value, [{ type: 'highlight' }]))
    const blockArb = fc.oneof(paragraphArb, headingArb, taskArb, imageArb, calloutArb, codeArb, linkArb, highlightArb)
    const docArb = fc.array(blockArb, { minLength: 1, maxLength: 6 }).map((content) => ({ type: 'doc', content }))
    await fc.assert(fc.asyncProperty(docArb, async (doc) => {
      await roundTrip(editor, doc)
    }), { numRuns: 80 })
  })
})
