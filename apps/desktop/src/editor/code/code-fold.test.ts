import { Editor, type JSONContent } from '@tiptap/core'
import { parseNote, serializeNote, type TipTapNode } from '@stride/core/note'
import { EditorState, NodeSelection, TextSelection } from '@tiptap/pm/state'
import { afterEach, describe, expect, it } from 'vitest'
import { createEditorExtensions } from '../extensions'
import { t } from '../../i18n'
import {
  codeBlockCollapsedAttribute,
  codeBlockCollapsedOf,
  codeBlockFoldLabel,
  codeIndentTransaction,
  collapsedCodeTypingTransaction,
} from './code-fold'

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

function createEditor(content?: JSONContent): Editor {
  const editor = new Editor({
    extensions: createEditorExtensions(),
    content: content ?? { type: 'doc', content: [{ type: 'paragraph' }] },
  })
  editors.push(editor)
  return editor
}

function codePos(editor: Editor, type = 'codeBlock'): number {
  let pos = -1
  editor.state.doc.descendants((node, position) => {
    if (node.type.name === type) {
      pos = position
      return false
    }
    return true
  })
  return pos
}

afterEach(() => {
  editors.splice(0).forEach((editor) => editor.destroy())
})

describe('code block fold', () => {
  it('labels a folded block with its first line and the line count', () => {
    expect(codeBlockFoldLabel('')).toBe(t('editor.codeBlock.empty'))
    expect(codeBlockFoldLabel('const x = 1')).toBe('const x = 1')
    expect(codeBlockFoldLabel('const x = 1\nconst y = 2')).toBe(t('editor.codeBlock.preview', { text: 'const x = 1', count: 2 }))
    expect(codeBlockFoldLabel('\n\nonly')).toBe(t('editor.codeBlock.preview', { text: 'only', count: 3 }))
    expect(codeBlockFoldLabel('   \n\n')).toBe(t('editor.codeBlock.lines', { count: 3 }))
  })

  it('reads only an explicit collapsed flag', () => {
    expect(codeBlockCollapsedOf(true)).toBe(true)
    expect(codeBlockCollapsedOf('true')).toBe(true)
    expect(codeBlockCollapsedOf(false)).toBe(false)
    expect(codeBlockCollapsedOf(undefined)).toBe(false)
    expect(codeBlockCollapsedOf('false')).toBe(false)
  })

  it('renders the flag on the element and parses it back', () => {
    const attr = codeBlockCollapsedAttribute()
    expect(attr.renderHTML?.({ collapsed: true })).toEqual({ 'data-collapsed': 'true' })
    expect(attr.renderHTML?.({ collapsed: false })).toEqual({})
    const element = { getAttribute: (name: string) => (name === 'data-collapsed' ? 'true' : null) }
    expect(attr.parseHTML?.(element as HTMLElement)).toBe(true)
  })

  it('keeps a missing flag expanded and a collapsed block through the note file', () => {
    const editor = createEditor({
      type: 'doc',
      content: [
        {
          type: 'codeBlock',
          attrs: { language: 'typescript' },
          content: [{ type: 'text', text: 'const x = 1' }],
        },
      ],
    })
    expect(editor.getJSON().content?.[0]?.attrs).toMatchObject({ language: 'typescript', collapsed: false })

    editor.commands.setContent({
      type: 'doc',
      content: [
        {
          type: 'codeBlock',
          attrs: { language: 'typescript', collapsed: true },
          content: [{ type: 'text', text: 'const x = 1\nconst y = 2' }],
        },
      ],
    })
    const canonical = editor.getJSON()
    const parsed = parseNote(
      serializeNote({ id: 'c', title: 'C', type: 'note', properties: {}, doc: canonical as TipTapNode }),
      'c',
    )
    editor.commands.setContent(parsed.doc)
    expect(editor.getJSON()).toEqual(canonical)
    expect(editor.state.doc.firstChild?.textContent).toBe('const x = 1\nconst y = 2')
    expect(editor.state.doc.firstChild?.attrs.collapsed).toBe(true)
  })

  it('selects a collapsed block when the caret opens inside it', async () => {
    const editor = createEditor({
      type: 'doc',
      content: [
        {
          type: 'codeBlock',
          attrs: { language: 'typescript', collapsed: true },
          content: [{ type: 'text', text: 'const x = 1' }],
        },
      ],
    })
    await Promise.resolve()
    expect(editor.state.selection).toBeInstanceOf(NodeSelection)
    expect(editor.view.dom.querySelector('.editor-code')?.classList.contains('is-collapsed')).toBe(true)
  })

  it('folds from the button, shows the summary, and expands again', () => {
    const editor = createEditor({
      type: 'doc',
      content: [
        {
          type: 'codeBlock',
          attrs: { language: 'typescript' },
          content: [{ type: 'text', text: 'const x = 1\nconst y = 2' }],
        },
      ],
    })
    const fold = editor.view.dom.querySelector('[data-testid="code-fold"]') as HTMLButtonElement
    expect(fold.getAttribute('aria-expanded')).toBe('true')
    expect(fold.getAttribute('aria-label')).toBe(t('editor.codeBlock.fold'))
    fold.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, cancelable: true }))
    expect(editor.state.doc.firstChild?.attrs.collapsed).toBe(true)
    expect(editor.state.selection).toBeInstanceOf(NodeSelection)
    const block = editor.view.dom.querySelector('.editor-code')
    expect(block?.classList.contains('is-collapsed')).toBe(true)
    const summary = editor.view.dom.querySelector('[data-testid="code-summary"]')
    expect(summary?.textContent).toBe(t('editor.codeBlock.preview', { text: 'const x = 1', count: 2 }))
    expect(summary?.hasAttribute('hidden')).toBe(false)
    expect(editor.view.dom.querySelector('.editor-code-frame')?.hasAttribute('hidden')).toBe(true)
    expect(fold.getAttribute('aria-label')).toBe(t('editor.codeBlock.expand'))

    fold.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, cancelable: true }))
    expect(editor.state.doc.firstChild?.attrs.collapsed).toBe(false)
    expect(editor.state.doc.firstChild?.textContent).toBe('const x = 1\nconst y = 2')
    expect(summary?.hasAttribute('hidden')).toBe(true)
  })

  it('inserts into a selected collapsed block instead of replacing it', () => {
    const editor = createEditor({
      type: 'doc',
      content: [
        {
          type: 'codeBlock',
          attrs: { language: 'typescript', collapsed: true },
          content: [{ type: 'text', text: 'const x = 1' }],
        },
      ],
    })
    const pos = codePos(editor)
    editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, pos)))
    const tr = collapsedCodeTypingTransaction(editor.state, { kind: 'insert', text: 'x' })
    expect(tr).not.toBeNull()
    editor.view.dispatch(tr!)
    expect(editor.state.doc.firstChild?.attrs.collapsed).toBe(false)
    expect(editor.state.doc.firstChild?.textContent).toBe('xconst x = 1')
    expect(editor.state.selection.empty).toBe(true)
    expect(editor.state.selection.from).toBe(pos + 2)
  })

  it('expands a selected collapsed block without deleting its source', () => {
    const editor = createEditor({
      type: 'doc',
      content: [
        {
          type: 'codeBlock',
          attrs: { language: null, collapsed: true },
          content: [{ type: 'text', text: 'plain' }],
        },
      ],
    })
    const pos = codePos(editor)
    editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, pos)))
    const tr = collapsedCodeTypingTransaction(editor.state, { kind: 'expand', edge: 'start' })
    expect(tr).not.toBeNull()
    editor.view.dispatch(tr!)
    expect(editor.state.doc.firstChild?.textContent).toBe('plain')
    expect(editor.state.doc.firstChild?.attrs.collapsed).toBe(false)
    expect(editor.state.selection.from).toBe(pos + 1)
  })

  it('ignores typing when the collapsed block is not selected as a whole', () => {
    const editor = createEditor({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'before' }] }],
    })
    expect(collapsedCodeTypingTransaction(editor.state, { kind: 'insert', text: 'x' })).toBeNull()
  })
})

describe('code indent', () => {
  it('inserts two spaces at the caret in a code block', () => {
    const editor = createEditor({
      type: 'doc',
      content: [
        {
          type: 'codeBlock',
          attrs: { language: 'typescript' },
          content: [{ type: 'text', text: 'const x = 1' }],
        },
      ],
    })
    expect(editor.schema.nodes.codeBlock?.spec.code).toBe(true)
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 6)))
    const tr = codeIndentTransaction(editor.state, 'indent')
    expect(tr).not.toBeNull()
    editor.view.dispatch(tr!)
    expect(editor.state.doc.firstChild?.textContent).toBe('const   x = 1')
    expect(editor.state.selection.from).toBe(8)
    expect(editor.state.selection.empty).toBe(true)
  })

  it('indents each selected line by two spaces', () => {
    const editor = createEditor({
      type: 'doc',
      content: [
        {
          type: 'codeBlock',
          attrs: { language: 'typescript' },
          content: [{ type: 'text', text: 'const x = 1\nreturn x' }],
        },
      ],
    })
    const end = editor.state.doc.content.size - 1
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 1, end)))
    const tr = codeIndentTransaction(editor.state, 'indent')
    editor.view.dispatch(tr!)
    expect(editor.state.doc.firstChild?.textContent).toBe('  const x = 1\n  return x')
  })

  it('indents a mermaid block the same way', () => {
    const editor = createEditor({
      type: 'doc',
      content: [
        {
          type: 'mermaid',
          attrs: { view: 'code' },
          content: [{ type: 'text', text: 'A --> B' }],
        },
      ],
    })
    expect(editor.schema.nodes.mermaid?.spec.code).toBe(true)
    const pos = codePos(editor, 'mermaid')
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, pos + 1)))
    const tr = codeIndentTransaction(editor.state, 'indent')
    expect(tr).not.toBeNull()
    editor.view.dispatch(tr!)
    expect(editor.state.doc.firstChild?.textContent).toBe('  A --> B')
  })

  it('removes up to two leading spaces on shift-tab', () => {
    const editor = createEditor({
      type: 'doc',
      content: [
        {
          type: 'codeBlock',
          attrs: { language: null },
          content: [{ type: 'text', text: '  return\n x' }],
        },
      ],
    })
    const first = EditorState.create({
      schema: editor.schema,
      doc: editor.state.doc,
      selection: TextSelection.create(editor.state.doc, 4),
    })
    const tr = codeIndentTransaction(first, 'outdent')
    expect(tr).not.toBeNull()
    const next = first.apply(tr!)
    expect(next.doc.firstChild?.textContent).toBe('return\n x')

    const second = EditorState.create({
      schema: editor.schema,
      doc: next.doc,
      selection: TextSelection.create(next.doc, next.doc.content.size - 2),
    })
    const again = codeIndentTransaction(second, 'outdent')
    expect(second.apply(again!).doc.firstChild?.textContent).toBe('return\nx')

    const bareDoc = second.apply(again!)
    const bare = codeIndentTransaction(
      EditorState.create({
        schema: editor.schema,
        doc: bareDoc.doc,
        selection: TextSelection.create(bareDoc.doc, 1),
      }),
      'outdent',
    )
    expect(bare?.docChanged).toBe(false)
  })

  it('leaves tab alone outside a code block', () => {
    const editor = createEditor({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'body' }] }],
    })
    expect(codeIndentTransaction(editor.state, 'indent')).toBeNull()
  })

  it('indents from the Tab key and skips the fold button', () => {
    const editor = createEditor({
      type: 'doc',
      content: [
        {
          type: 'codeBlock',
          attrs: { language: 'typescript' },
          content: [{ type: 'text', text: 'const x = 1' }],
        },
      ],
    })
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 6)))
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    editor.view.dom.dispatchEvent(tab)
    expect(editor.state.doc.firstChild?.textContent).toBe('const   x = 1')

    editor.commands.setContent({
      type: 'doc',
      content: [
        {
          type: 'codeBlock',
          attrs: { language: 'typescript' },
          content: [{ type: 'text', text: 'const x = 1' }],
        },
      ],
    })
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 6)))
    const fold = editor.view.dom.querySelector('[data-testid="code-fold"]') as HTMLButtonElement
    fold.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }))
    expect(editor.state.doc.firstChild?.textContent).toBe('const x = 1')
  })
})
