import { Editor, type JSONContent } from '@tiptap/core'
import { parseNote, serializeNote, type TipTapNode } from '@stride/core/note'
import { afterEach, describe, expect, it } from 'vitest'
import { createEditorExtensions } from './extensions'
import { filterSlashCommands, moveSlashSelection, slashCommands } from './slash'
import { taskSlashCommand } from './task'

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

function createEditor(): Editor {
  const editor = new Editor({
    extensions: createEditorExtensions(),
    content: { type: 'doc', content: [{ type: 'paragraph' }] },
  })
  editors.push(editor)
  return editor
}

function dropSlash(editor: Editor) {
  const to = editor.state.selection.from
  editor.chain().deleteRange({ from: to - 1, to }).run()
}

function runSlash(id: string) {
  const editor = createEditor()
  editor.commands.insertContent('/')
  dropSlash(editor)
  const command = slashCommands.find((item) => item.id === id)
  expect(command, id).toBeTruthy()
  command!.run(editor)
  return editor
}

function texts(doc: JSONContent): string {
  const parts: string[] = []
  const walk = (node: JSONContent | undefined) => {
    if (!node) return
    if (node.text) parts.push(node.text)
    node.content?.forEach(walk)
  }
  walk(doc)
  return parts.join('')
}

function hasNode(doc: JSONContent, type: string, level?: number): boolean {
  let found = false
  const walk = (node: JSONContent | undefined) => {
    if (!node || found) return
    if (node.type === type && (level === undefined || node.attrs?.level === level)) found = true
    node.content?.forEach(walk)
  }
  walk(doc)
  return found
}

afterEach(() => {
  editors.splice(0).forEach((editor) => editor.destroy())
})

describe('slash menu', () => {
  it('filters code without matching lists and returns every command for an empty query', () => {
    expect(filterSlashCommands('').map((item) => item.id)).toEqual([
      'h2',
      'h3',
      'bullet',
      'ordered',
      'quote',
      'code',
      'hr',
      'task',
      'table',
      'callout',
      'image',
      'math',
      'mermaid',
    ])
    for (const query of ['code', '代码']) {
      const ids = filterSlashCommands(query).map((item) => item.id)
      expect(ids, query).toContain('code')
      expect(ids, query).not.toContain('bullet')
    }
  })

  it('wraps the selection index and enter runs the chosen command', () => {
    expect(moveSlashSelection(0, 'up', 7)).toBe(6)
    expect(moveSlashSelection(6, 'down', 7)).toBe(0)
    const items = filterSlashCommands('')
    const index = moveSlashSelection(0, 'down', items.length)
    const editor = createEditor()
    editor.commands.insertContent('/')
    dropSlash(editor)
    items[index].run(editor)
    expect(items[index].id).toBe('h3')
    expect(hasNode(editor.getJSON(), 'heading', 3)).toBe(true)
    expect(texts(editor.getJSON())).not.toContain('/')
  })

  it('filters 任务 to the task command and inserts a task list', () => {
    expect(filterSlashCommands('任务').map((item) => item.id)).toContain('task')
    const registered = slashCommands.find((item) => item.id === 'task')
    expect(registered).toMatchObject({
      id: 'task',
      title: '任务列表',
      keywords: 'task todo 任务 待办',
    })

    const editor = createEditor()
    editor.commands.insertContent('/')
    dropSlash(editor)
    taskSlashCommand.run(editor)
    expect(hasNode(editor.getJSON(), 'taskList')).toBe(true)
    expect(texts(editor.getJSON())).not.toContain('/')
  })

  it('turns a slash into h2, a bullet list, or a rule', () => {
    const h2 = runSlash('h2')
    expect(hasNode(h2.getJSON(), 'heading', 2)).toBe(true)
    expect(texts(h2.getJSON())).not.toBe('/')

    const bullet = runSlash('bullet')
    expect(hasNode(bullet.getJSON(), 'bulletList')).toBe(true)
    expect(texts(bullet.getJSON())).not.toContain('/')

    const rule = runSlash('hr')
    expect(hasNode(rule.getJSON(), 'horizontalRule')).toBe(true)
    expect(texts(rule.getJSON())).not.toContain('/')
  })

  it('round-trips h2, bullet, code block, and rule through the note file', () => {
    const editor = createEditor()
    editor.commands.setContent({
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Title' }] },
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'item' }] }],
            },
          ],
        },
        { type: 'codeBlock', content: [{ type: 'text', text: 'const a = 1' }] },
        { type: 'horizontalRule' },
      ],
    })
    const canonical = editor.getJSON()
    const parsed = parseNote(serializeNote({
      id: 'slash',
      title: 'Slash',
      type: 'note',
      properties: {},
      doc: canonical as TipTapNode,
    }), 'slash')
    editor.commands.setContent(parsed.doc)
    expect(editor.getJSON()).toEqual(canonical)
  })
})
