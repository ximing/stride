// One rooted topic tree. ProseMirror and the DOM stay outside this module
// so rename, insert, and delete can be checked without an editor.

export type MindMapTopic = {
  id: string
  text: string
  children: MindMapTopic[]
}

export function createMindMap(text = ''): MindMapTopic {
  return { id: 't1', text, children: [] }
}

/** A stored attr is one root. Invalid nodes are dropped; the root is never missing. */
export function normalizeMindMap(value: unknown): MindMapTopic {
  const used = new Set<string>()
  return asTopic(value, used) ?? createMindMap()
}

export function findTopic(root: MindMapTopic, id: string): MindMapTopic | null {
  if (root.id === id) return root
  for (const child of root.children) {
    const found = findTopic(child, id)
    if (found) return found
  }
  return null
}

export function parentTopicId(root: MindMapTopic, id: string): string | null {
  for (const child of root.children) {
    if (child.id === id) return root.id
    const nested = parentTopicId(child, id)
    if (nested) return nested
  }
  return null
}

export function renameTopic(root: MindMapTopic, id: string, text: string): MindMapTopic {
  const current = findTopic(root, id)
  if (!current || current.text === text) return root
  return mapTopic(root, (topic) => (topic.id === id ? { ...topic, text } : topic))
}

/** Append a child under `parentId`. Returns null when that topic is absent. */
export function addChild(
  root: MindMapTopic,
  parentId: string,
  text = '',
): { tree: MindMapTopic; id: string } | null {
  if (!findTopic(root, parentId)) return null
  const id = freshId(root)
  const child: MindMapTopic = { id, text, children: [] }
  const tree = mapTopic(root, (topic) =>
    topic.id === parentId ? { ...topic, children: [...topic.children, child] } : topic,
  )
  return { tree, id }
}

/**
 * Insert a topic immediately after `id`, under the same parent.
 * The root has no sibling: that call returns null and leaves the single root in place.
 */
export function addSibling(
  root: MindMapTopic,
  id: string,
  text = '',
): { tree: MindMapTopic; id: string } | null {
  const parentId = parentTopicId(root, id)
  if (!parentId) return null
  const siblingId = freshId(root)
  const sibling: MindMapTopic = { id: siblingId, text, children: [] }
  const tree = mapTopic(root, (topic) => {
    if (topic.id !== parentId) return topic
    const index = topic.children.findIndex((child) => child.id === id)
    if (index < 0) return topic
    const children = topic.children.slice()
    children.splice(index + 1, 0, sibling)
    return { ...topic, children }
  })
  return { tree, id: siblingId }
}

/** Remove `id` and its descendants. Deleting the root returns the same tree. */
export function deleteTopic(root: MindMapTopic, id: string): MindMapTopic {
  if (root.id === id || !findTopic(root, id)) return root
  return strip(root, id)
}

function asTopic(value: unknown, used: Set<string>): MindMapTopic | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const id = typeof record.id === 'string' ? record.id : ''
  if (!id || used.has(id)) return null
  used.add(id)
  const text = typeof record.text === 'string' ? record.text : ''
  const children: MindMapTopic[] = []
  if (Array.isArray(record.children)) {
    for (const child of record.children) {
      const parsed = asTopic(child, used)
      if (parsed) children.push(parsed)
    }
  }
  return { id, text, children }
}

function mapTopic(topic: MindMapTopic, visit: (topic: MindMapTopic) => MindMapTopic): MindMapTopic {
  const children = topic.children.map((child) => mapTopic(child, visit))
  return visit({ id: topic.id, text: topic.text, children })
}

function strip(topic: MindMapTopic, id: string): MindMapTopic {
  return {
    id: topic.id,
    text: topic.text,
    children: topic.children.filter((child) => child.id !== id).map((child) => strip(child, id)),
  }
}

function freshId(root: MindMapTopic): string {
  const used = new Set<string>()
  const walk = (topic: MindMapTopic) => {
    used.add(topic.id)
    topic.children.forEach(walk)
  }
  walk(root)
  let n = 1
  while (used.has(`t${n}`)) n += 1
  return `t${n}`
}
