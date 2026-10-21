import { Editor } from '@tiptap/core'
import { stripLeadingH1, type TipTapNode } from '@stride/core/note'
import { describe, expect, it } from 'vitest'
import { createEditorExtensions } from '../../editor/extensions'
import { tocItems } from './toc'

function heading(level: number, text: string): TipTapNode {
  return { type: 'heading', attrs: { level }, content: [{ type: 'text', text }] }
}

describe('tocItems', () => {
  it('lists the title, then H2 and H3', () => {
    const doc: TipTapNode = {
      type: 'doc',
      content: [heading(2, 'Alpha'), heading(3, 'Beta')],
    }
    const items = tocItems('Note', doc)
    expect(items.map((item) => item.level)).toEqual([1, 2, 3])
    expect(items.map((item) => item.text)).toEqual(['Note', 'Alpha', 'Beta'])
    expect(items.map((item) => item.pos)).toEqual([0, 0, 7])
  })

  it('keeps a single title row when the stored doc still has its H1', () => {
    const doc: TipTapNode = {
      type: 'doc',
      content: [heading(1, 'Note'), heading(2, 'Alpha'), heading(3, 'Beta')],
    }
    expect(tocItems('Note', doc).map((item) => [item.level, item.text, item.pos])).toEqual([
      [1, 'Note', 0],
      [2, 'Alpha', 0],
      [3, 'Beta', 7],
    ])
  })

  it('shows the title when the body has no headings', () => {
    expect(tocItems('Note', { type: 'doc', content: [{ type: 'paragraph' }] })).toEqual([
      { level: 1, text: 'Note', pos: 0 },
    ])
  })

  it('points H2 and H3 positions at the editor heading nodes', () => {
    const doc: TipTapNode = {
      type: 'doc',
      content: [
        heading(1, 'Note'),
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'See ' },
            { type: 'wikilink', attrs: { target: 'Other' } },
          ],
        },
        heading(2, 'Alpha'),
        { type: 'horizontalRule' },
        heading(3, 'Beta'),
      ],
    }
    const editor = new Editor({
      extensions: createEditorExtensions(),
      content: stripLeadingH1(doc),
    })
    try {
      const headings = tocItems('Note', doc).filter((item) => item.level !== 1)
      expect(headings.map((item) => item.text)).toEqual(['Alpha', 'Beta'])
      for (const item of headings) {
        const node = editor.state.doc.nodeAt(item.pos)
        expect(node?.type.name).toBe('heading')
        expect(node?.attrs.level).toBe(item.level)
        expect(node?.textContent).toBe(item.text)
      }
    } finally {
      editor.destroy()
    }
  })
})
