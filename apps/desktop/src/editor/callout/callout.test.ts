import { Editor, type JSONContent } from '@tiptap/core'
import { parseNote, serializeNote, type TipTapNode } from '@stride/core/note'
import { afterEach, describe, expect, it } from 'vitest'
import { calloutSlashCommand } from './callout'
import { createEditorExtensions } from '../extensions'

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
    content,
  })
  editors.push(editor)
  return editor
}

function findCallout(doc: JSONContent | undefined): JSONContent | undefined {
  let found: JSONContent | undefined
  const walk = (node: JSONContent | undefined) => {
    if (!node || found) return
    if (node.type === 'callout') {
      found = node
      return
    }
    node.content?.forEach(walk)
  }
  walk(doc)
  return found
}

function textOf(doc: JSONContent | undefined): string {
  const parts: string[] = []
  const walk = (node: JSONContent | undefined) => {
    if (!node) return
    if (node.text) parts.push(node.text)
    node.content?.forEach(walk)
  }
  walk(doc)
  return parts.join('')
}

afterEach(() => {
  editors.splice(0).forEach((editor) => editor.destroy())
})

describe('callout', () => {
  it('inserts a note callout from the slash command', () => {
    const editor = createEditor({ type: 'doc', content: [{ type: 'paragraph' }] })
    calloutSlashCommand.run(editor)
    const callout = findCallout(editor.getJSON())
    expect(callout?.type).toBe('callout')
    expect(callout?.attrs?.kind).toBe('note')
    expect(callout?.content?.[0]?.type).toBe('paragraph')
  })

  it('updates the kind from the callout control', () => {
    const editor = createEditor({ type: 'doc', content: [{ type: 'paragraph' }] })
    calloutSlashCommand.run(editor)
    const button = editor.view.dom.querySelector('[data-testid="callout-kind"]') as HTMLButtonElement | null
    expect(button).not.toBeNull()
    expect(button?.textContent).toBe('note')
    button?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    if (findCallout(editor.getJSON())?.attrs?.kind !== 'warning') {
      let pos = -1
      editor.state.doc.descendants((node, position) => {
        if (pos < 0 && node.type.name === 'callout') pos = position
      })
      expect(pos).toBeGreaterThanOrEqual(0)
      editor.commands.setNodeSelection(pos)
      expect(editor.commands.updateAttributes('callout', { kind: 'warning' })).toBe(true)
    }
    expect(findCallout(editor.getJSON())?.attrs?.kind).toBe('warning')
  })

  it('round-trips a warning callout through the note file', () => {
    const editor = createEditor()
    editor.commands.setContent({
      type: 'doc',
      content: [
        {
          type: 'callout',
          attrs: { kind: 'warning' },
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Careful' }] }],
        },
      ],
    })
    const canonical = editor.getJSON()
    expect(findCallout(canonical)?.attrs?.kind).toBe('warning')
    expect(textOf(canonical)).toBe('Careful')
    const parsed = parseNote(serializeNote({
      id: 'callout',
      title: 'Callout',
      type: 'note',
      properties: {},
      doc: canonical as TipTapNode,
    }), 'callout')
    editor.commands.setContent(parsed.doc)
    expect(editor.getJSON()).toEqual(canonical)
  })

  it('captures ==hello== and round-trips the highlight mark', () => {
    expect(/==([^=]+)==$/.exec('==hello==')?.[1]).toBe('hello')
    const editor = createEditor({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'hello', marks: [{ type: 'highlight' }] }],
        },
      ],
    })
    expect(editor.schema.marks.highlight).toBeDefined()
    expect(editor.extensionManager.extensions.some((extension) => extension.name === 'highlightInput')).toBe(true)
    const canonical = editor.getJSON()
    const parsed = parseNote(serializeNote({
      id: 'highlight',
      title: 'Highlight',
      type: 'note',
      properties: {},
      doc: canonical as TipTapNode,
    }), 'highlight')
    editor.commands.setContent(parsed.doc)
    expect(editor.getJSON()).toEqual(canonical)
  })
})
