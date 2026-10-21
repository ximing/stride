import { Editor, type JSONContent } from '@tiptap/core'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { clearFormatting, createEditorExtensions } from './extensions'
import { wantsExternalLinkOpen, externalOpenUrl } from './external-link'
import { findTextMatches, replaceOneMatch } from './find'
import { findSeedFromSelection } from './find-hits'
import { MIN_IMAGE_WIDTH_PX, nextImageSize } from './image-resize'
import { imeBlocksEnter } from './ime-enter'
import { insertMathLatex } from './math'
import { dispatchMarkdownPaste } from './paste-dispatch'
import { insertMermaid } from './mermaid-insert'
import { runTableCommand } from './table-actions'
import { EditorToolbar } from './toolbar'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

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

function withVisibleBoxes<T>(run: () => T): T {
  const original = HTMLElement.prototype.getBoundingClientRect
  HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
    const box = original.call(this)
    if (box.width === 0 && box.height === 0) return layoutBox() as DOMRect
    return box
  }
  try {
    return run()
  } finally {
    HTMLElement.prototype.getBoundingClientRect = original
  }
}

const editors: Editor[] = []
const roots: Root[] = []
const hosts: HTMLElement[] = []

function createEditor(content?: JSONContent): Editor {
  const editor = new Editor({
    extensions: createEditorExtensions(),
    content: content ?? {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello' }] }],
    },
  })
  editors.push(editor)
  return editor
}

function countType(doc: JSONContent, type: string): number {
  let count = 0
  const walk = (node: JSONContent | undefined) => {
    if (!node) return
    if (node.type === type) count += 1
    node.content?.forEach(walk)
  }
  walk(doc)
  return count
}

function textMarks(doc: JSONContent, text: string): string[] {
  let marks: string[] = []
  const walk = (node: JSONContent | undefined) => {
    if (!node) return
    if (node.type === 'text' && node.text === text) marks = (node.marks ?? []).map((mark) => mark.type)
    node.content?.forEach(walk)
  }
  walk(doc)
  return marks
}

afterEach(() => {
  roots.splice(0).forEach((root) => root.unmount())
  hosts.splice(0).forEach((host) => host.remove())
  editors.splice(0).forEach((editor) => editor.destroy())
  document.body.replaceChildren()
})

describe('rich text aligned with inwit', () => {
  it('sets font size, color, background, sub/superscript, and align', () => {
    const editor = createEditor()
    editor.commands.setTextSelection({ from: 1, to: 6 })
    expect(editor.chain().focus().setFontSize('18px').run()).toBe(true)
    expect(editor.getAttributes('textStyle').fontSize).toBe('18px')
    expect(editor.chain().focus().setColor('#b3402a').run()).toBe(true)
    expect(editor.getAttributes('textStyle').color).toBe('#b3402a')
    expect(editor.chain().focus().setBackgroundColor('#f6e7a8').run()).toBe(true)
    expect(editor.getAttributes('textStyle').backgroundColor).toBe('#f6e7a8')
    expect(editor.chain().focus().toggleSubscript().run()).toBe(true)
    expect(editor.isActive('subscript')).toBe(true)
    expect(editor.chain().focus().toggleSubscript().toggleSuperscript().run()).toBe(true)
    expect(editor.isActive('superscript')).toBe(true)
    expect(editor.chain().focus().setTextAlign('center').run()).toBe(true)
    expect(editor.isActive({ textAlign: 'center' })).toBe(true)
    expect(editor.chain().focus().unsetTextAlign().run()).toBe(true)
    expect(editor.isActive({ textAlign: 'center' })).toBe(false)
    expect(JSON.stringify(editor.getJSON())).not.toContain('"textAlign":"center"')

    const comma = new KeyboardEvent('keydown', { key: ',', code: 'Comma', metaKey: true, cancelable: true })
    expect(editor.view.someProp('handleKeyDown', (run) => run(editor.view, comma))).toBeFalsy()
  })

  it('clears marks in the current block and lifts a heading, leaving the next block alone', () => {
    const editor = createEditor({
      type: 'doc',
      content: [
        {
          type: 'heading',
          attrs: { level: 2, textAlign: 'center' },
          content: [{ type: 'text', text: 'Title', marks: [{ type: 'bold' }] }],
        },
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'stay', marks: [{ type: 'bold' }] }],
        },
      ],
    })
    editor.commands.setTextSelection(2)
    expect(clearFormatting(editor)).toBe(true)
    const doc = editor.getJSON()
    expect(countType(doc, 'heading')).toBe(0)
    expect(textMarks(doc, 'Title')).not.toContain('bold')
    expect(textMarks(doc, 'stay')).toContain('bold')
    expect(JSON.stringify(doc)).not.toContain('center')
  })

  it('offers H1 through H6 from the heading menu and keeps a mid-document H1', async () => {
    const editor = createEditor()
    editor.commands.setTextSelection({ from: 1, to: 6 })
    const host = document.createElement('div')
    document.body.appendChild(host)
    hosts.push(host)
    const root = createRoot(host)
    roots.push(root)
    const openLinkRef = { current: () => true }
    await act(async () => {
      root.render(createElement(EditorToolbar, { editor, openLinkRef }))
    })

    const heading = document.querySelector('[data-testid="toolbar-heading"]') as HTMLButtonElement
    await act(async () => {
      heading.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
    })
    for (const level of ['1', '2', '3', '4', '5', '6']) {
      expect(document.querySelector(`[role="option"][data-value="${level}"]`)?.textContent).toBe(`H${level}`)
    }
    await act(async () => {
      ;(document.querySelector('[role="option"][data-value="1"]') as HTMLButtonElement).click()
    })
    expect(editor.isActive('heading', { level: 1 })).toBe(true)

    heading.focus()
    await act(async () => {
      heading.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
    })
    expect(document.querySelector('[role="listbox"][aria-label="标题"]')).not.toBeNull()
  })

  it('applies a swatch color, shows the find button pressed, and does not insert a second table', async () => {
    const editor = createEditor()
    editor.commands.setTextSelection({ from: 1, to: 6 })
    const host = document.createElement('div')
    document.body.appendChild(host)
    hosts.push(host)
    const root = createRoot(host)
    roots.push(root)
    await act(async () => {
      root.render(createElement(EditorToolbar, { editor, openLinkRef: { current: () => true } }))
    })

    await act(async () => {
      ;(document.querySelector('[data-testid="toolbar-color"]') as HTMLButtonElement).dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true, cancelable: true }),
      )
    })
    await act(async () => {
      ;(document.querySelector('[aria-label="赤"]') as HTMLButtonElement).click()
    })
    expect(editor.getAttributes('textStyle').color).toBe('#b3402a')

    await act(async () => {
      window.dispatchEvent(new CustomEvent('stride-editor-find-open', { detail: { open: true } }))
    })
    expect(document.querySelector('[data-testid="toolbar-find"]')?.getAttribute('aria-pressed')).toBe('true')

    await act(async () => {
      ;(document.querySelector('[data-testid="toolbar-table"]') as HTMLButtonElement).click()
    })
    expect(countType(editor.getJSON(), 'table')).toBe(1)
    expect(document.querySelector('[data-testid="table-addRowAfter"]')).not.toBeNull()
    await act(async () => {
      ;(document.querySelector('[data-testid="table-addRowAfter"]') as HTMLButtonElement).click()
    })
    const table = editor.getJSON().content?.find((node) => node.type === 'table')
    expect(table?.content?.length).toBe(4)
    await act(async () => {
      ;(document.querySelector('[data-testid="toolbar-table"]') as HTMLButtonElement).click()
    })
    expect(countType(editor.getJSON(), 'table')).toBe(1)
  })

  it('unsets a link when the prompt is submitted empty', async () => {
    const editor = createEditor()
    editor.commands.setTextSelection({ from: 1, to: 6 })
    editor.chain().focus().setLink({ href: 'https://example.com/a' }).run()
    const host = document.createElement('div')
    document.body.appendChild(host)
    hosts.push(host)
    const root = createRoot(host)
    roots.push(root)
    await act(async () => {
      root.render(createElement(EditorToolbar, { editor, openLinkRef: { current: () => true } }))
    })
    await act(async () => {
      ;(document.querySelector('[data-testid="toolbar-link"]') as HTMLButtonElement).click()
    })
    const input = document.querySelector('[data-testid="link-href"]') as HTMLInputElement
    expect(input.value).toBe('https://example.com/a')
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
      setter?.call(input, '   ')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.closest('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    expect(editor.isActive('link')).toBe(false)
    expect(document.querySelector('[data-testid="link-href"]')).toBeNull()
  })

  it('adds a table row from the shortcut and refuses to delete the only row', () => {
    const editor = createEditor({
      type: 'doc',
      content: [
        {
          type: 'table',
          content: [
            {
              type: 'tableRow',
              content: [
                { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }] }] },
              ],
            },
          ],
        },
      ],
    })
    editor.commands.setTextSelection(3)
    const before = editor.getJSON()
    expect(runTableCommand(editor, 'deleteRow')).toBe(false)
    expect(editor.getJSON()).toEqual(before)
    expect(editor.commands.keyboardShortcut('Mod-ArrowDown')).toBe(true)
    expect(editor.getJSON().content?.[0]?.content?.length).toBe(2)
    const outside = createEditor()
    const plain = outside.getJSON()
    outside.commands.keyboardShortcut('Mod-ArrowDown')
    expect(outside.getJSON()).toEqual(plain)
  })

  it('parses markdown on paste and leaves code blocks alone', () => {
    const editor = createEditor({ type: 'doc', content: [{ type: 'paragraph' }] })
    const markdown = '# Title\n\n- one\n- two\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n'
    expect(dispatchMarkdownPaste(editor.view, { getData: (type) => (type === 'text/html' ? '' : markdown) })).toBe(true)
    const doc = editor.getJSON()
    expect(countType(doc, 'heading')).toBe(1)
    expect(countType(doc, 'bulletList')).toBe(1)
    expect(countType(doc, 'table')).toBe(1)

    const code = createEditor({
      type: 'doc',
      content: [{ type: 'codeBlock', content: [{ type: 'text', text: 'plain' }] }],
    })
    code.commands.setTextSelection(2)
    expect(dispatchMarkdownPaste(code.view, { getData: () => '# Title\n\n- one' })).toBe(false)
    expect(code.getText()).toContain('plain')
  })

  it('inserts math, finds its latex, and inserts a mermaid sample', () => {
    const editor = createEditor({ type: 'doc', content: [{ type: 'paragraph' }] })
    expect(insertMathLatex(editor, '$E=mc^2$')).toBe(true)
    expect(countType(editor.getJSON(), 'inlineMath')).toBe(1)
    expect(findTextMatches(editor.state.doc, 'mc').length).toBe(1)
    expect(findTextMatches(editor.state.doc, 'MC', true).length).toBe(0)
    expect(insertMathLatex(editor, '$$\n\\frac{1}{2}\n$$')).toBe(true)
    expect(countType(editor.getJSON(), 'blockMath')).toBe(1)

    expect(insertMermaid(editor)).toBe(true)
    expect(JSON.stringify(editor.getJSON())).toContain('flowchart TD')
    expect(countType(editor.getJSON(), 'mermaid')).toBe(1)
  })

  it('turns a mermaid code block into a diagram and keeps a searchable language control', async () => {
    const editor = createEditor({
      type: 'doc',
      content: [
        {
          type: 'codeBlock',
          attrs: { language: 'javascript' },
          content: [{ type: 'text', text: 'flowchart TD\n  A-->B' }],
        },
      ],
    })
    editor.commands.updateAttributes('codeBlock', { language: 'mermaid' })
    expect(countType(editor.getJSON(), 'mermaid')).toBe(1)
    expect(countType(editor.getJSON(), 'codeBlock')).toBe(0)

    const loaded = createEditor({
      type: 'doc',
      content: [
        {
          type: 'codeBlock',
          attrs: { language: 'mermaid' },
          content: [{ type: 'text', text: 'flowchart LR\n  A-->B' }],
        },
      ],
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(countType(loaded.getJSON(), 'mermaid')).toBe(1)

    const code = createEditor({
      type: 'doc',
      content: [
        {
          type: 'codeBlock',
          attrs: { language: 'javascript' },
          content: [{ type: 'text', text: 'const a = 1' }],
        },
      ],
    })
    document.body.appendChild(code.view.dom)
    const button = code.view.dom.querySelector('[data-testid="code-language"]')
    expect(button?.textContent).toContain('JavaScript')
    expect(button?.tagName).toBe('BUTTON')
    withVisibleBoxes(() => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      const filter = document.querySelector('.editor-code-menu-filter') as HTMLInputElement | null
      expect(filter).not.toBeNull()
      filter!.value = 'type'
      filter!.dispatchEvent(new Event('input', { bubbles: true }))
      const labels = [...document.querySelectorAll('.editor-code-menu-option')].map((node) => node.textContent)
      expect(labels.some((label) => label?.includes('TypeScript'))).toBe(true)
      expect(labels.some((label) => label === 'JavaScript')).toBe(false)
    })
  })

  it('seeds find from a short selection and keeps marks on the replaced slice', () => {
    const editor = createEditor({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'ab' },
            { type: 'text', text: 'HELLO', marks: [{ type: 'bold' }] },
            { type: 'text', text: 'cd' },
          ],
        },
      ],
    })
    expect(findSeedFromSelection(editor.state.doc, 3, 8)).toBe('HELLO')
    expect(findSeedFromSelection(editor.state.doc, 1, 90)).toBeNull()
    expect(replaceOneMatch(editor, 'HELLO', 0, 'hi')).toBe(true)
    expect(editor.getText()).toBe('abhicd')
    expect(textMarks(editor.getJSON(), 'hi')).toContain('bold')
    expect(textMarks(editor.getJSON(), 'ab')).not.toContain('bold')
  })

  it('locks image aspect ratio at the minimum width and only command-clicks http links', () => {
    expect(
      nextImageSize({
        startWidth: 100,
        startHeight: 50,
        deltaX: 10,
        deltaY: 20,
        corner: 'se',
        minWidth: MIN_IMAGE_WIDTH_PX,
        maxWidth: 800,
      }),
    ).toEqual({ width: 140, height: 70 })
    expect(
      nextImageSize({
        startWidth: 100,
        startHeight: 50,
        deltaX: -80,
        deltaY: 0,
        corner: 'se',
        minWidth: MIN_IMAGE_WIDTH_PX,
        maxWidth: 800,
      }).width,
    ).toBe(MIN_IMAGE_WIDTH_PX)

    expect(wantsExternalLinkOpen({ button: 0, metaKey: true, ctrlKey: false, altKey: false })).toBe(true)
    expect(wantsExternalLinkOpen({ button: 0, metaKey: false, ctrlKey: false, altKey: false })).toBe(false)
    expect(wantsExternalLinkOpen({ button: 0, metaKey: true, ctrlKey: false, altKey: true })).toBe(false)
    expect(externalOpenUrl('https://example.com/a')).toBe('https://example.com/a')
    expect(externalOpenUrl('javascript:alert(1)')).toBeNull()

    const state = { composing: false, compositionEndedAt: 100 }
    expect(imeBlocksEnter({ key: 'Enter', keyCode: 13, isComposing: false, timeStamp: 120 }, state)).toBe(true)
    expect(imeBlocksEnter({ key: 'Enter', keyCode: 13, isComposing: false, timeStamp: 200 }, state)).toBe(false)
  })
})
