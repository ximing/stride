import { Editor, type JSONContent } from '@tiptap/core'
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
})
