import { describe, expect, it } from 'vitest'
import {
  addChild,
  addSibling,
  createMindMap,
  deleteTopic,
  normalizeMindMap,
  renameTopic,
  type MindMapTopic,
} from './tree'

function texts(root: MindMapTopic): string[] {
  return [root.text, ...root.children.flatMap((child) => texts(child))]
}

describe('mind map tree', () => {
  it('renames a topic without touching its siblings or the original tree', () => {
    const root = createMindMap('Root')
    const withChild = addChild(root, root.id, 'Alpha')
    expect(withChild).not.toBeNull()
    const sibling = addSibling(withChild!.tree, withChild!.id, 'Beta')
    expect(sibling).not.toBeNull()
    const before = structuredClone(sibling!.tree)

    const renamed = renameTopic(sibling!.tree, withChild!.id, 'Alpha 2')

    expect(sibling!.tree).toEqual(before)
    expect(texts(renamed)).toEqual(['Root', 'Alpha 2', 'Beta'])
    expect(renamed.children.map((child) => child.id)).toEqual([withChild!.id, sibling!.id])
  })

  it('appends a child and inserts a sibling after the selected topic', () => {
    const root = createMindMap('Root')
    const alpha = addChild(root, root.id, 'Alpha')
    const beta = addSibling(alpha!.tree, alpha!.id, 'Beta')
    const middle = addSibling(beta!.tree, alpha!.id, 'Middle')
    const nested = addChild(middle!.tree, alpha!.id, 'Alpha child')

    expect(middle!.tree.children.map((child) => child.text)).toEqual(['Alpha', 'Middle', 'Beta'])
    expect(nested!.tree.children[0]?.children.map((child) => child.text)).toEqual(['Alpha child'])
    const ids = [nested!.tree.id, ...collectIds(nested!.tree)]
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('deletes a subtree and refuses to remove or duplicate the root', () => {
    const root = createMindMap('Root')
    const alpha = addChild(root, root.id, 'Alpha')!
    const beta = addSibling(alpha.tree, alpha.id, 'Beta')!
    const gamma = addChild(beta.tree, alpha.id, 'Gamma')!
    const before = structuredClone(gamma.tree)

    expect(addSibling(gamma.tree, gamma.tree.id)).toBeNull()
    expect(deleteTopic(gamma.tree, gamma.tree.id)).toBe(gamma.tree)

    const deleted = deleteTopic(gamma.tree, alpha.id)
    expect(gamma.tree).toEqual(before)
    expect(deleted.id).toBe(root.id)
    expect(deleted.children.map((child) => child.text)).toEqual(['Beta'])
    expect(texts(deleted)).toEqual(['Root', 'Beta'])
    expect(deleted.children[0]?.children).toEqual([])
  })

  it('keeps one root, sibling order, and parent links when reading a stored tree', () => {
    const stored = {
      id: 'root',
      text: 'Center',
      children: [
        { id: 'a', text: 'Left', children: [{ id: 'a1', text: 'Leaf', children: [] }] },
        { text: 'missing id', children: [] },
        { id: 'b', text: 'Right', children: [] },
        { id: 'a', text: 'duplicate', children: [] },
      ],
    }

    const tree = normalizeMindMap(stored)

    expect(tree.id).toBe('root')
    expect(tree.children.map((child) => child.text)).toEqual(['Left', 'Right'])
    expect(tree.children[0]?.children.map((child) => child.text)).toEqual(['Leaf'])
    expect(normalizeMindMap(null).children).toEqual([])
    expect(normalizeMindMap([{ id: 'x', text: 'nope', children: [] }]).id).toBe('t1')
  })
})

function collectIds(topic: MindMapTopic): string[] {
  return topic.children.flatMap((child) => [child.id, ...collectIds(child)])
}
