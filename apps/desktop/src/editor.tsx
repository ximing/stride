import { Node, mergeAttributes } from '@tiptap/core'
import Placeholder from '@tiptap/extension-placeholder'
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { useEffect, useState } from 'react'
import { observer, useService } from '@rabjs/react'
import type { TipTapNode } from '@stride/core/note'
import { VaultService } from './services/vault.service'

const Wikilink = Node.create({
  name: 'wikilink',
  group: 'inline',
  inline: true,
  atom: true,
  addAttributes() {
    return { target: { default: '' } }
  },
  parseHTML() {
    return [{ tag: 'span[data-wikilink]' }]
  },
  renderHTML({ HTMLAttributes }) {
    const target = String(HTMLAttributes.target || '')
    return ['span', mergeAttributes(HTMLAttributes, { 'data-wikilink': target, class: 'wikilink' }), `[[${target}]]`]
  },
})

const NoteEditor = observer(function NoteEditor() {
  const vault = useService(VaultService)
  const note = vault.active
  const editor = useEditor({
    extensions: [
      StarterKit,
      Wikilink,
      Placeholder.configure({ placeholder: 'Write in the vault…' }),
    ],
    content: (note?.doc as object) || { type: 'doc', content: [{ type: 'paragraph' }] },
    onUpdate: ({ editor: current }) => {
      vault.updateDoc(current.getJSON() as TipTapNode)
    },
  })

  const docEpoch = vault.docEpoch
  useEffect(() => {
    if (!editor || !note) return
    editor.commands.setContent(note.doc, { emitUpdate: false })
  }, [editor, docEpoch, note?.id])

  const [linkDraft, setLinkDraft] = useState<string | null>(null)

  if (!note || !editor) return null

  return (
    <div data-testid="editor" className="editor">
      <div className="editor-tools">
        <button type="button" onClick={() => editor.chain().focus().toggleBold().run()}>Bold</button>
        <button type="button" onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}>Heading</button>
        <button type="button" onClick={() => setLinkDraft('')}>Wikilink</button>
        {linkDraft !== null && (
          <form
            className="wikilink-draft"
            onSubmit={(event) => {
              event.preventDefault()
              const target = linkDraft.trim()
              if (target) {
                editor.chain().focus().insertContent({ type: 'wikilink', attrs: { target } }).run()
              }
              setLinkDraft(null)
            }}
          >
            <input
              aria-label="Wikilink target"
              value={linkDraft}
              placeholder="Note title"
              onChange={(event) => setLinkDraft(event.target.value)}
            />
            <button type="submit">Insert</button>
            <button type="button" onClick={() => setLinkDraft(null)}>Cancel</button>
          </form>
        )}
      </div>
      <EditorContent editor={editor} />
    </div>
  )
})

export { NoteEditor }
