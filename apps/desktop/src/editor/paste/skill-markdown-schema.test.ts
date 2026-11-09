// Confirms the portable skill converter emits nodes this editor keeps.
// colspan/rowspan 1 and codeBlock collapsed:false are schema defaults, not lost content.
import { Editor, type JSONContent } from '@tiptap/core'
import { describe, expect, it } from 'vitest'
import { buildNote } from '../../../../../skills/stride/scripts/lib/markdown.mjs'
import { createEditorExtensions } from '../extensions'

const sample = `---
type: Project
status: active
---

# Alpha

See **bold** *italic* ~~gone~~ \`code\` ==mark== [link](https://example.com "t") and [[Team|Alias]] and $E=mc^2$.

- item
  - child

- [ ] parent
  - child

- [ ] todo
- [x] done

3. third

> quote

> [!WARNING]
> Careful

| A | B |
| --- | --- |
| 1 | 2 |

\`\`\`ts
const n = 1
\`\`\`

\`\`\`mermaid
graph TD
\`\`\`

![shot](attachments/shot.png)

![remote](https://example.com/a.png)

$$
a+b
$$
`

function project(node: JSONContent | undefined): unknown {
  if (!node) return null
  const attrs = node.attrs
    ? Object.fromEntries(Object.entries(node.attrs).filter(([key, value]) => {
      if (value == null || value === '') return false
      if ((key === 'colspan' || key === 'rowspan') && value === 1) return false
      if (key === 'collapsed' && value === false) return false
      return true
    }))
    : undefined
  return {
    type: node.type,
    ...(node.text ? { text: node.text } : {}),
    ...(attrs && Object.keys(attrs).length ? { attrs } : {}),
    ...(node.marks?.length
      ? { marks: node.marks.map((mark) => ({ type: mark.type, href: mark.attrs?.href, title: mark.attrs?.title })) }
      : {}),
    ...(node.content?.length ? { content: node.content.map((child) => project(child)) } : {}),
  }
}

describe('skill markdown survives the editor schema', () => {
  it('keeps converted nodes when the document is loaded', () => {
    const built = buildNote(sample) as { document: { doc: JSONContent } }
    const editor = new Editor({ extensions: createEditorExtensions(), content: built.document.doc })
    const loaded = editor.getJSON()
    editor.destroy()
    expect(project(loaded)).toEqual(project(built.document.doc))
  })
})
