import { Editor, type JSONContent } from '@tiptap/core'
import { parseNote, serializeNote, type TipTapNode } from '@stride/core/note'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'

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
import { afterEach, describe, expect, it } from 'vitest'
import { applyLink, createEditorExtensions, runFormat, unsetLink, type FormatName } from './extensions'
import { EditorToolbar, editorTools } from './toolbar'

const editors: Editor[] = []
const roots: Root[] = []
const hosts: HTMLElement[] = []

function createEditor(content?: JSONContent, onModK: () => boolean = () => true): Editor {
  const editor = new Editor({
    extensions: createEditorExtensions({ onModK }),
    content: content ?? {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello' }] }],
    },
  })
  editors.push(editor)
  return editor
}

function selectHello(editor: Editor) {
  editor.commands.setTextSelection({ from: 1, to: 6 })
}

function linkHref(doc: JSONContent): string | undefined {
  let href: string | undefined
  const walk = (node: JSONContent | undefined) => {
    if (!node || href) return
    const mark = node.marks?.find((item) => item.type === 'link')
    if (mark && typeof mark.attrs?.href === 'string') href = mark.attrs.href
    node.content?.forEach(walk)
  }
  walk(doc)
  return href
}

function hasMark(doc: JSONContent, type: string): boolean {
  let found = false
  const walk = (node: JSONContent | undefined) => {
    if (!node || found) return
    if (node.type === type || node.marks?.some((mark) => mark.type === type)) found = true
    node.content?.forEach(walk)
  }
  walk(doc)
  return found
}

afterEach(() => {
  roots.splice(0).forEach((root) => root.unmount())
  hosts.splice(0).forEach((host) => host.remove())
  editors.splice(0).forEach((editor) => editor.destroy())
})

const formats: Array<{
  name: FormatName
  shortcut?: string
  active: (editor: Editor) => boolean
}> = [
  { name: 'bold', shortcut: 'Mod-b', active: (editor) => editor.isActive('bold') },
  { name: 'italic', shortcut: 'Mod-i', active: (editor) => editor.isActive('italic') },
  { name: 'h2', shortcut: 'Mod-Alt-2', active: (editor) => editor.isActive('heading', { level: 2 }) },
  { name: 'h3', shortcut: 'Mod-Alt-3', active: (editor) => editor.isActive('heading', { level: 3 }) },
  { name: 'bullet', shortcut: 'Mod-Shift-8', active: (editor) => editor.isActive('bulletList') },
  { name: 'ordered', shortcut: 'Mod-Shift-7', active: (editor) => editor.isActive('orderedList') },
  { name: 'quote', shortcut: 'Mod-Shift-b', active: (editor) => editor.isActive('blockquote') },
  { name: 'strike', shortcut: 'Mod-Shift-s', active: (editor) => editor.isActive('strike') },
  { name: 'code', shortcut: 'Mod-e', active: (editor) => editor.isActive('code') },
  { name: 'codeBlock', active: (editor) => editor.isActive('codeBlock') },
  { name: 'highlight', shortcut: 'Mod-Shift-h', active: (editor) => editor.isActive('highlight') },
]

describe('editor formats', () => {
  it.each(formats)('$name toggles and keeps its shortcut', ({ name, shortcut, active }) => {
    const byCommand = createEditor()
    selectHello(byCommand)
    expect(runFormat(byCommand, name)).toBe(true)
    expect(active(byCommand)).toBe(true)

    if (!shortcut) return
    const byKey = createEditor()
    selectHello(byKey)
    expect(byKey.commands.keyboardShortcut(shortcut)).toBe(true)
    expect(active(byKey)).toBe(true)
  })

  it('inserts a horizontal rule without an H1 command', () => {
    const editor = createEditor()
    selectHello(editor)
    expect(runFormat(editor, 'hr')).toBe(true)
    expect(JSON.stringify(editor.getJSON())).toContain('horizontalRule')
    expect(runFormat(editor, 'h1' as FormatName)).toBe(false)
    expect(editor.isActive('heading', { level: 1 })).toBe(false)
    expect(editorTools.some((tool) => tool.id === 'h1' || tool.format === 'h1' || tool.label.includes('H1'))).toBe(false)
  })

  it('calls the Mod-k handler and does not insert a link by itself', () => {
    let calls = 0
    const editor = createEditor(undefined, () => {
      calls += 1
      return true
    })
    selectHello(editor)
    const before = editor.getJSON()
    expect(editor.commands.keyboardShortcut('Mod-k')).toBe(true)
    expect(calls).toBe(1)
    expect(editor.isActive('link')).toBe(false)
    expect(editor.getJSON()).toEqual(before)
  })

  it('applies and unsets a link mark', () => {
    const editor = createEditor()
    selectHello(editor)
    expect(applyLink(editor, 'https://example.com/path')).toBe(true)
    expect(editor.isActive('link')).toBe(true)
    expect(linkHref(editor.getJSON())).toBe('https://example.com/path')
    expect(unsetLink(editor)).toBe(true)
    expect(editor.isActive('link')).toBe(false)
    expect(linkHref(editor.getJSON())).toBeUndefined()
  })

  it('inserts the href as linked text when the selection is empty', () => {
    const editor = createEditor({ type: 'doc', content: [{ type: 'paragraph' }] })
    editor.commands.setTextSelection(1)
    expect(applyLink(editor, 'https://example.com/new')).toBe(true)
    expect(linkHref(editor.getJSON())).toBe('https://example.com/new')
    expect(JSON.stringify(editor.getJSON())).toContain('https://example.com/new')
  })

  it('round-trips marks, wikilink, heading, list, and quote through the note file', () => {
    const handwritten: TipTapNode = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'bold', marks: [{ type: 'bold' }] },
            { type: 'text', text: ' ' },
            { type: 'text', text: 'italic', marks: [{ type: 'italic' }] },
            { type: 'text', text: ' ' },
            { type: 'text', text: 'mark', marks: [{ type: 'highlight' }] },
            { type: 'text', text: ' ' },
            {
              type: 'text',
              text: 'site',
              marks: [{ type: 'link', attrs: { href: 'https://example.com/path' } }],
            },
            { type: 'text', text: ' ' },
            { type: 'wikilink', attrs: { target: 'Other note' } },
          ],
        },
        {
          type: 'heading',
          attrs: { level: 2 },
          content: [{ type: 'text', text: 'Section' }],
        },
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'item' }] }],
            },
          ],
        },
        {
          type: 'blockquote',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'quoted' }] }],
        },
      ],
    }
    const editor = createEditor()
    editor.commands.setContent(handwritten)
    const canonical = editor.getJSON()
    const parsed = parseNote(serializeNote({
      id: 'rich',
      title: 'Rich',
      type: 'note',
      properties: {},
      doc: canonical as TipTapNode,
    }), 'rich')
    editor.commands.setContent(parsed.doc)
    const again = editor.getJSON()
    expect(again).toEqual(canonical)
    expect(hasMark(again, 'highlight')).toBe(true)
    expect(hasMark(again, 'link')).toBe(true)
    expect(linkHref(again)).toBe('https://example.com/path')
    expect(hasMark(again, 'wikilink')).toBe(true)
  })

  it('renders toolbar and bubble controls and opens one link form', async () => {
    const openLinkRef: { current: () => boolean } = { current: () => true }
    const editor = new Editor({
      extensions: createEditorExtensions({ onModK: () => openLinkRef.current() }),
      content: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello' }] }],
      },
    })
    editors.push(editor)
    selectHello(editor)
    const editorHost = document.createElement('div')
    document.body.appendChild(editorHost)
    hosts.push(editorHost)
    const mount = editor.view.dom.parentElement
    editorHost.appendChild(mount && mount !== document.body ? mount : editor.view.dom)
    const host = document.createElement('div')
    document.body.appendChild(host)
    hosts.push(host)
    const root = createRoot(host)
    roots.push(root)
    await act(async () => {
      root.render(createElement(EditorToolbar, { editor, openLinkRef }))
    })

    const toolbarIds = [
      'toolbar-bold',
      'toolbar-italic',
      'toolbar-h2',
      'toolbar-h3',
      'toolbar-bullet',
      'toolbar-ordered',
      'toolbar-quote',
      'toolbar-link',
      'toolbar-highlight',
      'toolbar-strike',
      'toolbar-code',
      'toolbar-code-block',
      'toolbar-hr',
      'toolbar-wikilink',
    ]
    expect(host.querySelector('[data-testid="editor-toolbar"]')).not.toBeNull()
    for (const id of toolbarIds) {
      const button = document.querySelector(`[data-testid="${id}"]`)
      expect(button, id).not.toBeNull()
      expect(button?.getAttribute('type')).toBe('button')
    }
    expect(document.querySelector('[data-testid="toolbar-h1"]')).toBeNull()
    expect(document.querySelector('[data-testid="editor-bubble"]')).not.toBeNull()
    for (const id of ['bubble-bold', 'bubble-italic', 'bubble-h2', 'bubble-h3', 'bubble-bullet', 'bubble-ordered', 'bubble-quote', 'bubble-link', 'bubble-highlight']) {
      expect(document.querySelector(`[data-testid="${id}"]`), id).not.toBeNull()
    }
    for (const id of ['bubble-strike', 'bubble-code', 'bubble-code-block', 'bubble-hr', 'bubble-wikilink']) {
      expect(document.querySelector(`[data-testid="${id}"]`), id).toBeNull()
    }
    expect(document.querySelector('[data-testid="toolbar-bold"]')?.getAttribute('aria-label')).toBe('粗体 ⌘B')
    expect(document.querySelector('[data-testid="toolbar-highlight"]')?.getAttribute('aria-label')).toBe('高亮 ⌘⇧H')
    expect(document.querySelector('[data-testid="toolbar-link"]')?.getAttribute('aria-label')).toBe('链接 ⌘K')

    const before = editor.getJSON()
    await act(async () => {
      editor.commands.keyboardShortcut('Mod-k')
    })
    const href = document.querySelector('[data-testid="link-href"]') as HTMLInputElement | null
    expect(href).not.toBeNull()
    expect(href?.getAttribute('aria-label')).toBe('链接地址')
    expect(editor.getJSON()).toEqual(before)

    const cancel = [...document.querySelectorAll('button')].find((button) => button.textContent === '取消')
    await act(async () => {
      cancel?.click()
    })
    expect(document.querySelector('[data-testid="link-href"]')).toBeNull()
    expect(editor.getJSON()).toEqual(before)

    await act(async () => {
      ;(document.querySelector('[data-testid="toolbar-link"]') as HTMLButtonElement).click()
    })
    const input = document.querySelector('[data-testid="link-href"]') as HTMLInputElement
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
      setter?.call(input, 'https://example.com/ui')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.closest('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    expect(linkHref(editor.getJSON())).toBe('https://example.com/ui')

    selectHello(editor)
    await act(async () => {
      ;(document.querySelector('[data-testid="toolbar-link"]') as HTMLButtonElement).click()
    })
    const filled = document.querySelector('[data-testid="link-href"]') as HTMLInputElement
    expect(filled.value).toBe('https://example.com/ui')
    await act(async () => {
      ;(document.querySelector('[data-testid="link-unset"]') as HTMLButtonElement).click()
    })
    expect(linkHref(editor.getJSON())).toBeUndefined()

    await act(async () => {
      ;(document.querySelector('[data-testid="toolbar-wikilink"]') as HTMLButtonElement).click()
    })
    const target = document.querySelector('[aria-label="Wikilink target"]') as HTMLInputElement
    expect(target).not.toBeNull()
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
      setter?.call(target, 'Other note')
      target.dispatchEvent(new Event('input', { bubbles: true }))
      target.closest('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    expect(hasMark(editor.getJSON(), 'wikilink')).toBe(true)
  })
})
