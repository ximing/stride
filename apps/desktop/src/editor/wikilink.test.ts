import { Editor, type JSONContent } from '@tiptap/core'
import { parseNote, serializeNote, type TipTapNode } from '@stride/core/note'
import { afterEach, describe, expect, it } from 'vitest'
import { createEditorExtensions } from './extensions'
import { filterWikilinkNotes, resolveWikilinkClick, runWikilinkCommand, type WikilinkSourceNote } from './wikilink'

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

const notes: WikilinkSourceNote[] = [
  { id: 'other', title: 'Other note', type: 'note', properties: {} },
  { id: 'inbox', title: 'Inbox', type: 'note', properties: {} },
  { id: 'daily', title: 'Daily', type: 'note', properties: {} },
]

function createEditor(source: WikilinkSourceNote[] = notes): Editor {
  const editor = new Editor({
    extensions: createEditorExtensions({
      getNotes: () => source.filter((note) => note.type !== 'Type').map((note) => ({ id: note.id, title: note.title })),
      onOpen: () => {},
    }),
    content: { type: 'doc', content: [{ type: 'paragraph' }] },
  })
  editors.push(editor)
  return editor
}

function wikilinks(doc: JSONContent | TipTapNode): JSONContent[] {
  const found: JSONContent[] = []
  const walk = (node: JSONContent | TipTapNode | undefined) => {
    if (!node) return
    if (node.type === 'wikilink') found.push(node)
    node.content?.forEach(walk)
  }
  walk(doc)
  return found
}

function triggerRange(editor: Editor): { from: number; to: number } {
  let from = 0
  let to = 0
  editor.state.doc.descendants((node, pos) => {
    if (!node.isText || !node.text?.includes('[[')) return
    const index = node.text.indexOf('[[')
    from = pos + index
    to = pos + node.text.length
  })
  return { from, to }
}

afterEach(() => {
  editors.splice(0).forEach((editor) => editor.destroy())
  document.querySelectorAll('[data-testid="wikilink-menu"]').forEach((node) => node.remove())
})

describe('wikilink suggestions', () => {
  it('filters titles by lowercase includes and appends create unless the name matches', () => {
    const filtered = filterWikilinkNotes(notes, 'ot')
    expect(filtered.filter((item) => item.kind === 'note').map((item) => item.title)).toEqual(['Other note'])
    expect(filtered.some((item) => item.kind === 'note' && item.title === 'Inbox')).toBe(false)
    expect(filtered.at(-1)).toEqual({ kind: 'create', title: 'ot' })

    const exact = filterWikilinkNotes(notes, '  OTHER NOTE  ')
    expect(exact.some((item) => item.kind === 'create')).toBe(false)
    expect(exact.map((item) => item.kind === 'note' && item.title)).toContain('Other note')

    const hidden = filterWikilinkNotes([
      ...notes,
      { id: 'type', title: 'Other type', type: 'Type', properties: {} },
      { id: 'old', title: 'Other old', type: 'note', properties: { archived: true } },
    ], 'other')
    const titles = hidden.filter((item) => item.kind === 'note').map((item) => item.title)
    expect(titles).toEqual(['Other note'])
    expect(titles).not.toContain('Other type')
    expect(titles).not.toContain('Other old')
  })

  it('inserts a wikilink for the matched note and removes the trigger text', () => {
    const editor = createEditor()
    editor.commands.insertContent('[[Ot')
    const chosen = filterWikilinkNotes(notes, 'Ot').find((item) => item.kind === 'note')
    expect(chosen && chosen.kind === 'note' && chosen.title).toBe('Other note')
    expect(runWikilinkCommand(editor, triggerRange(editor), chosen?.title ?? '')).toBe(true)
    expect(wikilinks(editor.getJSON())[0]).toMatchObject({
      type: 'wikilink',
      attrs: { target: 'Other note' },
    })
    expect(editor.getText()).not.toContain('[[')
  })

  it('keeps target and alias through serializeNote, parseNote, and setContent', () => {
    const editor = createEditor()
    editor.commands.setContent({
      type: 'doc',
      content: [{
        type: 'paragraph',
        content: [{ type: 'wikilink', attrs: { target: 'Other note', alias: '别名' } }],
      }],
    })
    const canonical = editor.getJSON()
    const parsed = parseNote(serializeNote({
      id: 'linked',
      title: 'Linked',
      type: 'note',
      properties: {},
      doc: canonical as TipTapNode,
    }), 'linked')
    expect(wikilinks(parsed.doc)[0]?.attrs).toMatchObject({ target: 'Other note', alias: '别名' })
    editor.commands.setContent(parsed.doc)
    expect(editor.getJSON()).toEqual(canonical)
  })

  it('resolves a click to select or create', () => {
    const vaultNotes: WikilinkSourceNote[] = [
      { id: 'known', title: 'Known', type: 'note', properties: {} },
      { id: 'type-doc', title: 'Known', type: 'Type', properties: {} },
      { id: 'gone', title: 'Gone', type: 'note', properties: { archived: true } },
    ]
    expect(resolveWikilinkClick(vaultNotes, 'Known')).toEqual({ type: 'select', id: 'known' })
    expect(resolveWikilinkClick(vaultNotes, 'Gone')).toEqual({ type: 'create', title: 'Gone' })
    expect(resolveWikilinkClick(vaultNotes, 'Missing')).toEqual({ type: 'create', title: 'Missing' })
  })
})
