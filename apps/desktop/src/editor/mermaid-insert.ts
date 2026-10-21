import type { Editor } from '@tiptap/core'
import { NodeSelection } from '@tiptap/pm/state'

export const MERMAID_SAMPLE = 'flowchart TD\n  A[开始] --> B[结束]'

function hostBlockDepth(editor: Editor): number | null {
  const { $from } = editor.state.selection
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const name = $from.node(depth).type.name
    if (name === 'codeBlock' || name === 'mermaid') return depth
  }
  return null
}

/** Insert a mermaid block. A code or mermaid host cannot contain another block. */
export function insertMermaid(editor: Editor, source = MERMAID_SAMPLE): boolean {
  const block = {
    type: 'mermaid',
    attrs: { view: 'split' },
    content: [{ type: 'text', text: source }],
  }
  const { selection } = editor.state
  if (
    selection instanceof NodeSelection &&
    (selection.node.type.name === 'codeBlock' || selection.node.type.name === 'mermaid')
  ) {
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
