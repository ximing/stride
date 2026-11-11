import { Editor, type JSONContent } from '@tiptap/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createEditorExtensions } from '../extensions'
import { blockHitAt, copyBlock, cutBlock, deleteBlock, placeBlockActions } from './block-actions'

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
  const editor = new Editor({ extensions: createEditorExtensions(), content })
  editors.push(editor)
  return editor
}

function code(text: string): JSONContent {
  return { type: 'codeBlock', attrs: { language: 'typescript' }, content: [{ type: 'text', text }] }
}

function texts(doc: JSONContent): string[] {
  const found: string[] = []
  const walk = (node: JSONContent) => {
    if (node.type === 'text' && node.text) found.push(node.text)
    node.content?.forEach(walk)
  }
  walk(doc)
  return found
}

function installClipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(window.navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  })
}

afterEach(() => {
  editors.splice(0).forEach((editor) => editor.destroy())
  delete (window.navigator as { clipboard?: unknown }).clipboard
  vi.restoreAllMocks()
})

describe('blockHitAt', () => {
  it('resolves a code block and a table, and ignores a paragraph', () => {
    const editor = createEditor({
      type: 'doc',
      content: [
        code('one'),
        { type: 'paragraph', content: [{ type: 'text', text: 'mid' }] },
        code('two'),
        {
          type: 'table',
          content: [
            {
              type: 'tableRow',
              content: [
                { type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'H' }] }] },
                { type: 'tableHeader', content: [{ type: 'paragraph' }] },
              ],
            },
            {
              type: 'tableRow',
              content: [
                { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'cell' }] }] },
                { type: 'tableCell', content: [{ type: 'paragraph' }] },
              ],
            },
          ],
        },
      ],
    })
    const blocks = [...editor.view.dom.querySelectorAll<HTMLElement>('.editor-code')]
    expect(blocks).toHaveLength(2)
    const second = blockHitAt(editor.view, blocks[1]!)
    expect(second).toMatchObject({ kind: 'codeBlock' })
    expect(editor.state.doc.nodeAt(second!.pos)?.textContent).toBe('two')

    const paragraph = editor.view.dom.querySelector('p')
    expect(blockHitAt(editor.view, paragraph)).toBeNull()

    const cell = editor.view.dom.querySelector('td')
    const table = blockHitAt(editor.view, cell)
    expect(table?.kind).toBe('table')
    expect(editor.state.doc.nodeAt(table!.pos)?.type.name).toBe('table')
  })
})

describe('block actions', () => {
  it('copies a code block as text and does not remove it', async () => {
    const written: string[] = []
    installClipboard(async (text) => {
      written.push(text)
    })
    const editor = createEditor({ type: 'doc', content: [code('const a = 1'), { type: 'paragraph' }] })
    const hit = blockHitAt(editor.view, editor.view.dom.querySelector('.editor-code'))
    expect(await copyBlock(editor, hit!.pos)).toBe(true)
    expect(written.join('\n')).toContain('const a = 1')
    expect(texts(editor.getJSON())).toContain('const a = 1')
  })

  it('cuts the block only after the clipboard write succeeds', async () => {
    const written: string[] = []
    installClipboard(async (text) => {
      written.push(text)
    })
    const editor = createEditor({
      type: 'doc',
      content: [code('keep'), { type: 'paragraph', content: [{ type: 'text', text: 'after' }] }, code('drop')],
    })
    const blocks = [...editor.view.dom.querySelectorAll('.editor-code')]
    const hit = blockHitAt(editor.view, blocks[1]!)
    expect(await cutBlock(editor, hit!.pos)).toBe(true)
    expect(written.join('\n')).toContain('drop')
    expect(texts(editor.getJSON())).toEqual(['keep', 'after'])
    expect(editor.commands.undo()).toBe(true)
    expect(texts(editor.getJSON())).toContain('drop')
  })

  it('keeps the block when the clipboard write fails', async () => {
    installClipboard(async () => {
      throw new Error('denied')
    })
    const editor = createEditor({ type: 'doc', content: [code('stay')] })
    const hit = blockHitAt(editor.view, editor.view.dom.querySelector('.editor-code'))
    expect(await cutBlock(editor, hit!.pos)).toBe(false)
    expect(texts(editor.getJSON())).toContain('stay')
  })

  it('cuts a table after the clipboard write', async () => {
    const written: string[] = []
    installClipboard(async (text) => {
      written.push(text)
    })
    const editor = createEditor({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'before' }] },
        {
          type: 'table',
          content: [
            {
              type: 'tableRow',
              content: [
                { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A' }] }] },
              ],
            },
          ],
        },
      ],
    })
    const hit = blockHitAt(editor.view, editor.view.dom.querySelector('td'))
    expect(await cutBlock(editor, hit!.pos)).toBe(true)
    expect(written.join('\n')).toContain('A')
    expect(texts(editor.getJSON())).toEqual(['before'])
  })

  it('deletes a table and refuses when the editor is read-only', () => {
    const editor = createEditor({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'before' }] },
        {
          type: 'table',
          content: [
            {
              type: 'tableRow',
              content: [
                { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A' }] }] },
              ],
            },
          ],
        },
      ],
    })
    const hit = blockHitAt(editor.view, editor.view.dom.querySelector('td'))
    editor.setEditable(false)
    expect(deleteBlock(editor, hit!.pos)).toBe(false)
    expect(texts(editor.getJSON())).toContain('A')
    editor.setEditable(true)
    expect(deleteBlock(editor, hit!.pos)).toBe(true)
    expect(texts(editor.getJSON())).toEqual(['before'])
  })
})

describe('placeBlockActions', () => {
  const frame = { top: 0, left: 0 }

  it('aligns the bar to the top-left of a visible block', () => {
    expect(
      placeBlockActions({
        block: { top: 40, left: 80, bottom: 160 },
        frame,
        scrollTop: 0,
        scrollLeft: 0,
        clientTop: 0,
        clientLeft: 0,
        clientHeight: 600,
      }),
    ).toEqual({ top: 40, left: 48 })
  })

  it('pins the bar inside the scrollport when the block top has scrolled away', () => {
    expect(
      placeBlockActions({
        block: { top: -40, left: 80, bottom: 500 },
        frame,
        scrollTop: 80,
        scrollLeft: 0,
        clientTop: 0,
        clientLeft: 0,
        clientHeight: 300,
      }),
    ).toEqual({ top: 86, left: 48 })
  })

  it('returns null when the block is outside the scrollport', () => {
    expect(
      placeBlockActions({
        block: { top: -200, left: 80, bottom: -20 },
        frame,
        scrollTop: 100,
        scrollLeft: 0,
        clientTop: 0,
        clientLeft: 0,
        clientHeight: 200,
      }),
    ).toBeNull()
  })
})
