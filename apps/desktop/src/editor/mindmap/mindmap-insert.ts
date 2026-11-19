import type { Editor } from '@tiptap/core'
import { NodeSelection } from '@tiptap/pm/state'
import { createMindMap } from './tree'

const HOSTS = new Set(['codeBlock', 'mermaid', 'mindMap'])

function hostBlockDepth(editor: Editor): number | null {
  const { $from } = editor.state.selection
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    if (HOSTS.has($from.node(depth).type.name)) return depth
  }
  return null
}

/** Insert one rooted mind map. A code, diagram, or mind-map host cannot contain it. */
export function insertMindMap(editor: Editor): boolean {
  const block = { type: 'mindMap', attrs: { tree: createMindMap() } }
  const { selection } = editor.state
  if (selection instanceof NodeSelection && HOSTS.has(selection.node.type.name)) {
    return editor.chain().focus().insertContentAt(selection.to, block).run()
  }
  const { $from } = selection
  const host = hostBlockDepth(editor)
  if (host !== null) return editor.chain().focus().insertContentAt($from.after(host), block).run()
  if (editor.isActive('listItem') || editor.isActive('taskItem')) {
    return editor.chain().focus().insertContentAt($from.after($from.depth), block).run()
  }
  return editor.chain().focus().insertContent(block).run()
}
