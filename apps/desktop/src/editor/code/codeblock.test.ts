import { Editor } from '@tiptap/core'
import { parseNote, serializeNote, type TipTapNode } from '@stride/core/note'
import { afterEach, describe, expect, it } from 'vitest'
import { lastCopiedText } from './codeblock'
import { createEditorExtensions } from '../extensions'

const layoutBox = () => ({ x: 0, y: 0, top: 0, left: 0, right: 1, bottom: 1, width: 1, height: 1, toJSON() { return {} } })
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

const codeBlockDoc = {
  type: 'doc',
  content: [
    {
      type: 'codeBlock',
      attrs: { language: 'typescript' },
      content: [{ type: 'text', text: 'export const n = 1' }],
    },
  ],
}

function median(times: number[]): number {
  const sorted = [...times].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 0) return (sorted[mid - 1]! + sorted[mid]!) / 2
  return sorted[mid]!
}

describe('code block', () => {
  let editor: Editor

  function createEditor() {
    editor = new Editor({
      extensions: createEditorExtensions(),
      content: { type: 'doc', content: [{ type: 'paragraph' }] },
    })
  }

  afterEach(() => {
    editor?.destroy()
  })

  it('serializes a typescript code block through the note document', () => {
    createEditor()
    editor.commands.setContent(codeBlockDoc)
    const canonical = editor.getJSON()
    const parsed = parseNote(
      serializeNote({ id: 'c', title: 'C', type: 'note', properties: {}, doc: canonical as TipTapNode }),
      'c',
    )
    editor.commands.setContent(parsed.doc)
    expect(editor.getJSON()).toEqual(canonical)
  })

  it('copies the code block text', () => {
    createEditor()
    editor.commands.setContent(codeBlockDoc)
    const button = editor.view.dom.querySelector('[data-testid="code-copy"]')
    expect(button).toBeTruthy()
    button?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(lastCopiedText).toBe('export const n = 1')
  })

  it('keeps inserts cheap while highlighting stays off the transaction', () => {
    createEditor()
    const paragraph = `word `.repeat(10000)
    const code = Array.from({ length: 80 }, (_, i) => `const value${i} = ${i}`).join('\n')
    editor.commands.setContent({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: paragraph }] },
        {
          type: 'codeBlock',
          attrs: { language: 'javascript' },
          content: [{ type: 'text', text: code }],
        },
      ],
    })

    const paragraphTimes: number[] = []
    for (let i = 0; i < 30; i++) {
      const start = performance.now()
      editor.commands.insertContentAt(2, 'x')
      paragraphTimes.push(performance.now() - start)
    }

    const codeTimes: number[] = []
    for (let i = 0; i < 10; i++) {
      let codePos = -1
      editor.state.doc.descendants((node, pos) => {
        if (node.type.name === 'codeBlock') {
          codePos = pos + 1
          return false
        }
        return true
      })
      const start = performance.now()
      editor.commands.insertContentAt(codePos, 'y')
      codeTimes.push(performance.now() - start)
    }

    console.log(
      `PERF paragraph p50=${median(paragraphTimes).toFixed(1)} max=${Math.max(...paragraphTimes).toFixed(1)} code p50=${median(codeTimes).toFixed(1)} max=${Math.max(...codeTimes).toFixed(1)}`,
    )
    expect(Math.max(...paragraphTimes, ...codeTimes)).toBeLessThan(50)
  })
})
