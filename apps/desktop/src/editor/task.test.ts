import { Editor, type JSONContent } from '@tiptap/core'
import { parseNote, serializeNote, type TipTapNode } from '@stride/core/note'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { createEditorExtensions, runFormat } from './extensions'
import { taskProgress, taskSlashCommand, type TaskCountNode } from './task'
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

const editors: Editor[] = []
const roots: Root[] = []
const hosts: HTMLElement[] = []

function createEditor(content?: JSONContent): Editor {
  const editor = new Editor({
    extensions: createEditorExtensions({ onModK: () => true }),
    content,
  })
  editors.push(editor)
  return editor
}

function findAll(doc: JSONContent | undefined, type: string): JSONContent[] {
  const found: JSONContent[] = []
  const walk = (node: JSONContent | undefined) => {
    if (!node) return
    if (node.type === type) found.push(node)
    node.content?.forEach(walk)
  }
  walk(doc)
  return found
}

function taskItem(text: string, checked: boolean): JSONContent {
  return {
    type: 'taskItem',
    attrs: { checked },
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  }
}

function checkFirst(editor: Editor) {
  const box = editor.view.dom.querySelector('input[type="checkbox"]') as HTMLInputElement | null
  expect(box).not.toBeNull()
  box!.checked = true
  box!.dispatchEvent(new Event('change', { bubbles: true }))
}

afterEach(() => {
  roots.splice(0).forEach((root) => root.unmount())
  hosts.splice(0).forEach((host) => host.remove())
  editors.splice(0).forEach((editor) => editor.destroy())
})

describe('task list', () => {
  it('toggles a task list whose item starts unchecked', () => {
    const editor = createEditor({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello' }] }],
    })
    editor.commands.setTextSelection({ from: 1, to: 6 })
    expect(editor.commands.toggleTaskList()).toBe(true)
    const json = editor.getJSON()
    expect(findAll(json, 'taskList')).toHaveLength(1)
    expect(findAll(json, 'bulletList')).toHaveLength(0)
    expect(findAll(json, 'listItem')).toHaveLength(0)
    const items = findAll(json, 'taskItem')
    expect(items).toHaveLength(1)
    expect(items[0]?.attrs?.checked).toBe(false)
    expect(runFormat(editor, 'task')).toBe(true)
    expect(findAll(editor.getJSON(), 'taskList')).toHaveLength(0)
  })

  it('sets checked after the checkbox change', () => {
    const editor = createEditor({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello' }] }],
    })
    editor.commands.setTextSelection({ from: 1, to: 6 })
    expect(editor.commands.toggleTaskList()).toBe(true)
    checkFirst(editor)
    expect(findAll(editor.getJSON(), 'taskItem')[0]?.attrs?.checked).toBe(true)
  })

  it('counts direct and nested items as done/total', () => {
    expect(taskProgress({ type: 'taskList' })).toEqual({ done: 0, total: 0 })
    expect(taskProgress(undefined)).toEqual({ done: 0, total: 0 })

    const three: TaskCountNode = {
      type: 'doc',
      content: [
        {
          type: 'taskList',
          content: [taskItem('one', false), taskItem('two', true), taskItem('three', false)],
        },
      ],
    }
    expect(taskProgress(three)).toEqual({ done: 1, total: 3 })

    const nested: TaskCountNode = {
      type: 'doc',
      content: [
        {
          type: 'taskList',
          content: [
            {
              type: 'taskItem',
              attrs: { checked: false },
              content: [
                { type: 'paragraph', content: [{ type: 'text', text: 'parent' }] },
                { type: 'taskList', content: [taskItem('child', true)] },
              ],
            },
            taskItem('sibling', false),
          ],
        },
        { type: 'paragraph' },
      ],
    }
    expect(taskProgress(nested)).toEqual({ done: 1, total: 3 })
    const outer = nested.content?.[0]
    const inner = outer?.content?.[0]?.content?.[1]
    expect(taskProgress(outer)).toEqual({ done: 1, total: 3 })
    expect(taskProgress(inner)).toEqual({ done: 1, total: 1 })

    const editor = createEditor(three as JSONContent)
    expect(taskProgress(editor.getJSON())).toEqual({ done: 1, total: 3 })
    const progress = editor.view.dom.querySelector('[data-testid="task-progress"]')
    expect(progress?.textContent).toBe('1/3')

    const live = createEditor({
      type: 'doc',
      content: [
        {
          type: 'taskList',
          content: [taskItem('one', false), taskItem('two', false), taskItem('three', false)],
        },
      ],
    })
    expect(live.view.dom.querySelector('[data-testid="task-progress"]')?.textContent).toBe('0/3')
    checkFirst(live)
    expect(taskProgress(live.getJSON())).toEqual({ done: 1, total: 3 })
    expect(live.view.dom.querySelector('[data-testid="task-progress"]')?.textContent).toBe('1/3')
  })

  it('keeps checked through serialize and parse', () => {
    const handwritten: TipTapNode = {
      type: 'doc',
      content: [
        {
          type: 'taskList',
          content: [
            {
              type: 'taskItem',
              attrs: { checked: true },
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'done' }] }],
            },
            {
              type: 'taskItem',
              attrs: { checked: false },
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'open' }] }],
            },
          ],
        },
      ],
    }
    const editor = createEditor()
    editor.commands.setContent(handwritten)
    const canonical = editor.getJSON()
    const checked = findAll(canonical, 'taskItem').map((item) => item.attrs?.checked)
    expect(checked).toEqual([true, false])
    const parsed = parseNote(serializeNote({
      id: 'tasks',
      title: 'Tasks',
      type: 'note',
      properties: {},
      doc: canonical as TipTapNode,
    }), 'tasks')
    editor.commands.setContent(parsed.doc)
    const again = editor.getJSON()
    expect(again).toEqual(canonical)
    expect(findAll(again, 'taskItem').map((item) => item.attrs?.checked)).toEqual([true, false])
  })

  it('renders a task toolbar button outside the bubble menu', async () => {
    expect(taskSlashCommand).toMatchObject({
      id: 'task',
      title: '任务列表',
      keywords: 'task todo 任务 待办',
    })
    const openLinkRef: { current: () => boolean } = { current: () => true }
    const editor = createEditor({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello' }] }],
    })
    editor.commands.setTextSelection({ from: 1, to: 6 })
    const host = document.createElement('div')
    document.body.appendChild(host)
    hosts.push(host)
    const root = createRoot(host)
    roots.push(root)
    await act(async () => {
      root.render(createElement(EditorToolbar, { editor, openLinkRef }))
    })
    const button = host.querySelector('[data-testid="toolbar-task"]')
    expect(button).not.toBeNull()
    expect(button?.getAttribute('aria-label')).toBe('任务列表')
    expect(button?.getAttribute('type')).toBe('button')
    expect(document.querySelector('[data-testid="bubble-task"]')).toBeNull()
    await act(async () => {
      ;(button as HTMLButtonElement).click()
    })
    const items = findAll(editor.getJSON(), 'taskItem')
    expect(findAll(editor.getJSON(), 'taskList')).toHaveLength(1)
    expect(items[0]?.attrs?.checked).toBe(false)
    expect(findAll(editor.getJSON(), 'bulletList')).toHaveLength(0)
  })
})
