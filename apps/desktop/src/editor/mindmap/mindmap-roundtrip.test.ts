import { Editor, type JSONContent } from '@tiptap/core'
import { plainText, type TipTapNode } from '@stride/core/note'
import { MemoryFileSystem } from '@stride/platform'
import { afterEach, describe, expect, it } from 'vitest'
import { saveNote } from '../../../../../packages/core/src/vault'
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

const sampleTree = {
  id: 't1',
  text: 'Maps',
  children: [
    {
      id: 't2',
      text: 'Left',
      children: [{ id: 't4', text: 'Left child', children: [] }],
    },
    { id: 't3', text: 'Right', children: [] },
  ],
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

function mindMap(doc: JSONContent | TipTapNode): JSONContent | TipTapNode | undefined {
  let found: JSONContent | TipTapNode | undefined
  const walk = (node: JSONContent | TipTapNode | undefined) => {
    if (!node || found) return
    if (node.type === 'mindMap') {
      found = node
      return
    }
    node.content?.forEach(walk)
  }
  walk(doc)
  return found
}

type StoredTopic = {
  id: string
  text: string
  children: StoredTopic[]
}

function links(topic: StoredTopic, parent: string | null = null): string[] {
  const row = `${parent ?? ''}>${topic.text}`
  return [row, ...topic.children.flatMap((child) => links(child, topic.text))]
}

afterEach(() => {
  editors.splice(0).forEach((editor) => editor.destroy())
})

describe('mind map round trip', () => {
  it('keeps topic labels, parents, and sibling order through saveNote', async () => {
    const editor = createEditor()
    editor.commands.setContent({
      type: 'doc',
      content: [{ type: 'mindMap', attrs: { tree: sampleTree } }],
    })
    const canonical = editor.getJSON()
    const stored = mindMap(canonical)
    expect(stored?.type).toBe('mindMap')
    expect(stored?.attrs?.tree).toEqual(sampleTree)

    const fs = new MemoryFileSystem()
    const saved = await saveNote(fs, {
      id: 'mind-map',
      title: 'Mind map',
      type: 'note',
      properties: {},
      doc: canonical as TipTapNode,
    })

    editor.commands.setContent(saved.doc)
    expect(editor.getJSON()).toEqual(canonical)

    const tree = mindMap(saved.doc)?.attrs?.tree as StoredTopic
    expect(links(tree)).toEqual(['>Maps', 'Maps>Left', 'Left>Left child', 'Maps>Right'])
    expect(tree.children.map((child) => child.text)).toEqual(['Left', 'Right'])
    expect(saved.doc.content?.some((node) => node.type === 'mindMap')).toBe(true)
    expect(saved.doc.content?.some((node) => node.type === 'mermaid')).toBe(false)
    expect(saved.doc.content?.some((node) => node.type === 'bulletList' || node.type === 'orderedList')).toBe(false)

    const text = plainText(saved.doc)
    for (const label of ['Maps', 'Left', 'Right', 'Left child']) {
      expect(text).toContain(label)
    }
  })
})
