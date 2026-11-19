import { Editor, type JSONContent } from '@tiptap/core'
import { afterEach, describe, expect, it } from 'vitest'
import { createEditorExtensions } from '../extensions'
import { applyMindMapMenuHistory } from './mindmap'
import { insertMindMap } from './mindmap-insert'
import { installImeEnterGuard } from '../ime-enter'
import { filterSlashCommands, slashCommands } from '../slash/slash'

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

type StoredTopic = {
  id: string
  text: string
  children: StoredTopic[]
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

function mindMap(doc: JSONContent): JSONContent {
  let found: JSONContent | undefined
  const walk = (node: JSONContent | undefined) => {
    if (!node || found) return
    if (node.type === 'mindMap') {
      found = node
      return
    }
    node.content?.forEach(walk)
  }
  walk(doc)
  return found ?? { type: 'missing' }
}

function treeOf(editor: Editor): StoredTopic {
  const node = mindMap(editor.getJSON())
  return node.attrs?.tree as StoredTopic
}

function typesOf(doc: JSONContent): string[] {
  const types: string[] = []
  const walk = (node: JSONContent | undefined) => {
    if (!node) return
    if (node.type) types.push(node.type)
    node.content?.forEach(walk)
  }
  walk(doc)
  return types
}

function topicCount(topic: StoredTopic): number {
  return 1 + topic.children.reduce((sum, child) => sum + topicCount(child), 0)
}

function blockOf(editor: Editor): HTMLElement {
  const block = editor.view.dom.querySelector<HTMLElement>('[data-testid="mindmap"]')
  expect(block).not.toBeNull()
  return block!
}

function topicInput(editor: Editor, id: string): HTMLInputElement {
  const input = blockOf(editor).querySelector<HTMLInputElement>(`[data-testid="mindmap-topic"][data-topic-id="${id}"]`)
  expect(input).not.toBeNull()
  return input!
}

function typeTopic(editor: Editor, id: string, text: string) {
  const input = topicInput(editor, id)
  input.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
  input.value = text
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

function press(editor: Editor, id: string, key: string, extra: { keyCode?: number; isComposing?: boolean } = {}) {
  const input = topicInput(editor, id)
  const event = new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
    isComposing: extra.isComposing ?? false,
  })
  Object.defineProperty(event, 'keyCode', { value: extra.keyCode ?? (key === 'Enter' ? 13 : 0) })
  Object.defineProperty(event, 'isComposing', { value: extra.isComposing ?? false })
  input.dispatchEvent(event)
}

function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function insertMindMapFromSlash(editor: Editor) {
  editor.commands.insertContent('/')
  const to = editor.state.selection.from
  editor.chain().deleteRange({ from: to - 1, to }).run()
  const command = slashCommands.find((item) => item.id === 'mindMap')
  expect(command).toBeTruthy()
  command!.run(editor)
}

afterEach(() => {
  editors.splice(0).forEach((editor) => {
    editor.view.dom.remove()
    editor.destroy()
  })
})

describe('mind map block', () => {
  it('inserts one root after the caret, and after a code block that cannot hold it', () => {
    const editor = createEditor()
    expect(insertMindMap(editor)).toBe(true)
    expect(treeOf(editor)).toEqual({ id: 't1', text: '', children: [] })

    const code = createEditor()
    code.commands.setContent({
      type: 'doc',
      content: [{ type: 'codeBlock', content: [{ type: 'text', text: 'keep' }] }],
    })
    code.commands.setTextSelection(2)
    expect(insertMindMap(code)).toBe(true)
    const content = code.getJSON().content ?? []
    expect(content[0]?.type).toBe('codeBlock')
    expect(content[0]?.content?.[0]?.text).toBe('keep')
    expect(content[1]?.type).toBe('mindMap')
    expect(content[1]?.attrs?.tree).toEqual({ id: 't1', text: '', children: [] })
  })

  it('inserts one root from the slash command and edits topics in the document', async () => {
    expect(filterSlashCommands('').map((item) => item.id)).toContain('mindMap')
    expect(filterSlashCommands('mind map').map((item) => item.id)).toEqual(['mindMap'])
    expect(filterSlashCommands('脑图').map((item) => item.id)).toEqual(['mindMap'])

    const editor = createEditor()
    insertMindMapFromSlash(editor)

    const inserted = treeOf(editor)
    expect(mindMap(editor.getJSON()).type).toBe('mindMap')
    expect(inserted.children).toEqual([])
    expect(typesOf(editor.getJSON())).not.toContain('mermaid')
    expect(typesOf(editor.getJSON())).not.toContain('bulletList')
    expect(typesOf(editor.getJSON())).not.toContain('orderedList')

    const block = blockOf(editor)
    expect(block.querySelector('ul, ol, li')).toBeNull()
    expect(block.querySelector('[data-mermaid]')).toBeNull()
    expect(block.querySelectorAll('[data-testid="mindmap-topic"]')).toHaveLength(1)
    expect(block.querySelector('[data-testid="mindmap-delete"]')).toBeNull()
    const rootInput = topicInput(editor, inserted.id)
    expect(rootInput.tagName).toBe('INPUT')
    expect(rootInput.readOnly).toBe(true)

    press(editor, inserted.id, 'Backspace')
    expect(treeOf(editor).id).toBe(inserted.id)
    expect(treeOf(editor).children).toEqual([])

    const beforeRename = structuredClone(treeOf(editor))
    typeTopic(editor, inserted.id, 'Center')
    expect(treeOf(editor).text).toBe('Center')
    expect(topicInput(editor, inserted.id).value).toBe('Center')
    editor.commands.undo()
    expect(treeOf(editor)).toEqual(beforeRename)
    editor.commands.redo()
    expect(treeOf(editor).text).toBe('Center')

    press(editor, inserted.id, 'Tab')
    const withChild = treeOf(editor)
    expect(withChild.children).toHaveLength(1)
    expect(withChild.children[0]?.text).toBe('')
    expect(blockOf(editor).querySelectorAll('[data-testid="mindmap-topic"]')).toHaveLength(topicCount(withChild))

    const childId = withChild.children[0]!.id
    press(editor, childId, 'Enter')
    await flush()
    const withSibling = treeOf(editor)
    expect(withSibling.children.map((child) => child.id)).toEqual([childId, withSibling.children[1]?.id])
    expect(withSibling.children).toHaveLength(2)
    expect(withSibling.children[0]?.id).toBe(childId)
    expect(withSibling.children[1]?.id).not.toBe(childId)
    expect(blockOf(editor).querySelectorAll('[data-testid="mindmap-topic"]')).toHaveLength(3)

    typeTopic(editor, childId, 'Alpha')
    const siblingId = withSibling.children[1]!.id
    typeTopic(editor, siblingId, 'Beta')
    press(editor, childId, 'Tab')
    const nested = treeOf(editor)
    const alpha = nested.children[0]!
    expect(alpha.text).toBe('Alpha')
    expect(nested.children[1]?.text).toBe('Beta')
    expect(alpha.children).toHaveLength(1)
    const grandchildId = alpha.children[0]!.id
    typeTopic(editor, grandchildId, 'Gamma')
    expect(blockOf(editor).querySelectorAll('[data-testid="mindmap-topic"]')).toHaveLength(topicCount(treeOf(editor)))
    expect(blockOf(editor).querySelectorAll('.mindmap-links path')).toHaveLength(topicCount(treeOf(editor)) - 1)

    const beforeDelete = structuredClone(treeOf(editor))
    const remove = blockOf(editor).querySelector<HTMLButtonElement>(
      `[data-testid="mindmap-delete"][data-topic-id="${childId}"]`,
    )
    expect(remove).not.toBeNull()
    remove!.click()
    const deleted = treeOf(editor)
    expect(deleted.id).toBe(inserted.id)
    expect(deleted.text).toBe('Center')
    expect(deleted.children.map((child) => child.text)).toEqual(['Beta'])
    expect(JSON.stringify(deleted)).not.toContain('Gamma')
    expect(JSON.stringify(deleted)).not.toContain('Alpha')

    editor.commands.undo()
    expect(treeOf(editor)).toEqual(beforeDelete)
    expect(blockOf(editor).querySelectorAll('[data-testid="mindmap-topic"]')).toHaveLength(topicCount(beforeDelete))
    expect(blockOf(editor).querySelector('ul, ol, li')).toBeNull()
  })

  it('selects a topic on click and edits it on double-click', () => {
    const editor = createEditor()
    document.body.append(editor.view.dom)
    insertMindMapFromSlash(editor)
    const rootId = treeOf(editor).id
    const root = topicInput(editor, rootId)
    expect(root.readOnly).toBe(true)

    root.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    const rootNode = root.closest('.mindmap-node')
    expect(root.readOnly).toBe(true)
    expect(rootNode?.classList.contains('is-current')).toBe(true)
    expect(rootNode?.classList.contains('is-editing')).toBe(false)
    root.value = 'Skipped'
    root.dispatchEvent(new Event('input', { bubbles: true }))
    expect(treeOf(editor).text).toBe('')
    expect(root.value).toBe('')

    root.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    expect(root.readOnly).toBe(false)
    expect(root.closest('.mindmap-node')?.classList.contains('is-editing')).toBe(true)
    typeTopic(editor, rootId, 'Center')
    expect(treeOf(editor).text).toBe('Center')

    press(editor, rootId, 'Escape')
    expect(root.readOnly).toBe(true)
    expect(root.closest('.mindmap-node')?.classList.contains('is-current')).toBe(true)
    expect(treeOf(editor).text).toBe('Center')

    press(editor, rootId, 'Tab')
    const childId = treeOf(editor).children[0]!.id
    const child = topicInput(editor, childId)
    expect(document.activeElement).toBe(child)
    expect(child.readOnly).toBe(false)
    expect(child.closest('.mindmap-node')?.classList.contains('is-editing')).toBe(true)

    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    const liveRoot = topicInput(editor, rootId)
    const liveChild = topicInput(editor, childId)
    expect(liveRoot.closest('.mindmap-node')?.classList.contains('is-current')).toBe(false)
    expect(liveChild.readOnly).toBe(true)
    expect(liveChild.closest('.mindmap-node')?.classList.contains('is-editing')).toBe(false)
  })

  it('does not add a sibling when Enter confirms an IME composition', async () => {
    const editor = createEditor()
    insertMindMapFromSlash(editor)
    const rootId = treeOf(editor).id
    press(editor, rootId, 'Tab')
    const childId = treeOf(editor).children[0]!.id
    expect(treeOf(editor).children).toHaveLength(1)

    installImeEnterGuard()

    press(editor, childId, 'Enter', { keyCode: 13, isComposing: false })
    window.dispatchEvent(new Event('compositionend'))
    await flush()
    expect(treeOf(editor).children).toHaveLength(1)

    press(editor, childId, 'Enter', { keyCode: 229, isComposing: true })
    await flush()
    expect(treeOf(editor).children).toHaveLength(1)

    window.dispatchEvent(new Event('compositionstart'))
    window.dispatchEvent(new Event('compositionend'))
    press(editor, childId, 'Enter', { keyCode: 13, isComposing: false })
    await flush()
    expect(treeOf(editor).children).toHaveLength(1)

    await new Promise((resolve) => setTimeout(resolve, 70))
    press(editor, childId, 'Enter', { keyCode: 13, isComposing: false })
    await flush()
    expect(treeOf(editor).children).toHaveLength(2)
    expect(treeOf(editor).children[0]?.id).toBe(childId)
  })

  it('undoes from the topic field, including the menu undo, and lets Shift+Tab leave', async () => {
    const editor = createEditor()
    document.body.append(editor.view.dom)
    insertMindMapFromSlash(editor)
    const rootId = treeOf(editor).id
    typeTopic(editor, rootId, 'Center')
    press(editor, rootId, 'Tab')
    expect(treeOf(editor).children).toHaveLength(1)

    const undo = new KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true, cancelable: true })
    topicInput(editor, rootId).dispatchEvent(undo)
    expect(undo.defaultPrevented).toBe(true)
    expect(treeOf(editor).children).toEqual([])
    expect(treeOf(editor).text).toBe('Center')

    await flush()
    const redo = new KeyboardEvent('keydown', { key: 'z', metaKey: true, shiftKey: true, bubbles: true, cancelable: true })
    topicInput(editor, rootId).dispatchEvent(redo)
    expect(treeOf(editor).children).toHaveLength(1)
    await flush()
    const again = new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true })
    topicInput(editor, rootId).dispatchEvent(again)
    expect(treeOf(editor).children).toEqual([])

    const shiftTab = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true })
    topicInput(editor, rootId).dispatchEvent(shiftTab)
    expect(shiftTab.defaultPrevented).toBe(false)
    expect(treeOf(editor).children).toEqual([])

    await flush()
    const input = topicInput(editor, rootId)
    const before = new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'historyUndo' })
    input.dispatchEvent(before)
    expect(before.defaultPrevented).toBe(true)
    expect(treeOf(editor).text).toBe('')
    expect(input.value).toBe('')
    const stacked = new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'historyUndo' })
    input.dispatchEvent(stacked)
    expect(stacked.defaultPrevented).toBe(true)
    expect(treeOf(editor).text).toBe('')
  })

  it('undoes and redoes from the menu after the topic field is replaced', async () => {
    const editor = createEditor()
    document.body.append(editor.view.dom)
    insertMindMapFromSlash(editor)
    const rootId = treeOf(editor).id
    typeTopic(editor, rootId, 'Center')
    press(editor, rootId, 'Tab')
    const childId = treeOf(editor).children[0]!.id
    const child = topicInput(editor, childId)
    expect(document.activeElement).toBe(child)

    expect(applyMindMapMenuHistory('undo')).toBe(true)
    expect(treeOf(editor).children).toEqual([])
    await flush()
    expect(applyMindMapMenuHistory('redo')).toBe(true)
    expect(treeOf(editor).children).toHaveLength(1)

    await flush()
    const focused = document.activeElement
    if (focused instanceof HTMLElement) focused.blur()
    expect(document.activeElement).not.toBeInstanceOf(HTMLInputElement)
    expect(applyMindMapMenuHistory('undo')).toBe(true)
    expect(treeOf(editor).children).toEqual([])

    editor.view.dom.focus()
    expect(applyMindMapMenuHistory('undo')).toBe(false)
    expect(treeOf(editor).text).toBe('Center')
  })

  it('keeps a proportional caret when undo rewrites the focused topic', () => {
    const editor = createEditor()
    document.body.append(editor.view.dom)
    insertMindMapFromSlash(editor)
    const id = treeOf(editor).id
    typeTopic(editor, id, 'ab')
    typeTopic(editor, id, 'abcd')
    const input = topicInput(editor, id)
    input.focus()
    input.setSelectionRange(2, 2)
    editor.commands.undo()
    expect(input.value).toBe('ab')
    expect(input.selectionStart).toBe(1)
    expect(input.selectionEnd).toBe(1)
  })

  it('commits a composition once, not each intermediate string', () => {
    const editor = createEditor()
    insertMindMapFromSlash(editor)
    const id = treeOf(editor).id
    const input = topicInput(editor, id)
    input.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    input.value = 'ni'
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertCompositionText' }))
    expect(treeOf(editor).text).toBe('')
    input.value = '你'
    input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '你' }))
    expect(treeOf(editor).text).toBe('你')
    editor.commands.undo()
    expect(treeOf(editor).text).toBe('')
  })
})
