import { Editor, type JSONContent } from '@tiptap/core'
import { plainText, type TipTapNode } from '@stride/core/note'
import { afterEach, describe, expect, it } from 'vitest'
import { createEditorExtensions } from '../extensions'
import { plainTextSelection } from './search-jump'

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

function createEditor(content: JSONContent): Editor {
  const editor = new Editor({
    extensions: createEditorExtensions(),
    content,
  })
  editors.push(editor)
  return editor
}

function selectedText(editor: Editor, storedPlain: string, offset: number, length: number): string {
  const range = plainTextSelection(editor.state.doc, storedPlain, offset, length)
  expect(range).not.toBeNull()
  return editor.state.doc.textBetween(range!.from, range!.to)
}

afterEach(() => {
  editors.splice(0).forEach((editor) => editor.destroy())
})

describe('plain text search jump', () => {
  it('maps a later paragraph onto its text node', () => {
    const editor = createEditor({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'hello' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'world' }] },
      ],
    })
    expect(selectedText(editor, 'hello world', 6, 5)).toBe('world')
  })

  it('maps across a mark boundary after whitespace collapse', () => {
    const editor = createEditor({
      type: 'doc',
      content: [{
        type: 'paragraph',
        content: [
          { type: 'text', text: 'hello ' },
          { type: 'text', text: 'world', marks: [{ type: 'bold' }] },
        ],
      }],
    })
    expect(selectedText(editor, 'hello world', 6, 5)).toBe('world')
  })

  it('skips a leading title that the editor does not show', () => {
    const editor = createEditor({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: '咖啡' }] }],
    })
    expect(selectedText(editor, '采购清单 咖啡', 5, 2)).toBe('咖啡')
  })

  it('keeps text after a mind map aligned with plainText', () => {
    const editor = createEditor({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Hello' }] },
        {
          type: 'mindMap',
          attrs: {
            tree: {
              id: 't1',
              text: 'Root',
              children: [
                { id: 't2', text: 'Alpha', children: [{ id: 't4', text: 'Gamma', children: [] }] },
                { id: 't3', text: '   ', children: [] },
                { id: 't5', text: 'Beta', children: [] },
              ],
            },
          },
        },
        { type: 'paragraph', content: [{ type: 'text', text: 'World' }] },
      ],
    })
    const stored = plainText(editor.getJSON() as TipTapNode)
    expect(stored).toContain('Root')
    expect(stored).toContain('Gamma')
    expect(stored.indexOf('Alpha')).toBeLessThan(stored.indexOf('Gamma'))
    expect(stored.indexOf('Gamma')).toBeLessThan(stored.indexOf('Beta'))
    expect(stored.indexOf('Beta')).toBeLessThan(stored.indexOf('World'))

    const topicAt = stored.indexOf('Gamma')
    const topic = plainTextSelection(editor.state.doc, stored, topicAt, 'Gamma'.length)
    expect(topic).not.toBeNull()
    const topicNode = editor.state.doc.nodeAt(topic!.from)
    expect(topicNode?.type.name).toBe('mindMap')
    expect(topic!.to).toBe(topic!.from + topicNode!.nodeSize)

    const worldAt = stored.indexOf('World')
    const world = plainTextSelection(editor.state.doc, stored, worldAt, 'World'.length)
    expect(world).not.toBeNull()
    expect(world!.to - world!.from).toBe('World'.length)
    const worldNode = editor.state.doc.nodeAt(world!.from)
    expect(worldNode?.isText).toBe(true)
    expect(worldNode?.text).toBe('World')
    expect(editor.state.doc.textBetween(world!.from, world!.to)).toBe('World')
  })
})
