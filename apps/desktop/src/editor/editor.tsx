import type { TipTapNode } from '@stride/core/note'
import { stripLeadingH1 } from '@stride/core/note'
import { EditorContent, useEditor } from '@tiptap/react'
import { useEffect, useMemo, useRef } from 'react'
import { observer, useService } from '@rabjs/react'
import { VaultService } from '../services/vault.service'
import { createEditorExtensions } from './extensions'
import { EditorToolbar } from './toolbar'

const emptyDoc = { type: 'doc', content: [{ type: 'paragraph' }] }

export const NoteEditor = observer(function NoteEditor() {
  const vault = useService(VaultService)
  const note = vault.active
  const openLinkRef = useRef<() => boolean>(() => true)
  const extensions = useMemo(
    () => createEditorExtensions({ onModK: () => openLinkRef.current() }),
    [],
  )
  const editor = useEditor({
    extensions,
    content: ((note ? stripLeadingH1(note.doc) : emptyDoc) as object),
    onUpdate: ({ editor: current }) => {
      vault.updateDoc(current.getJSON() as TipTapNode)
    },
  })

  const docEpoch = vault.docEpoch
  useEffect(() => {
    if (!editor || !note) return
    editor.commands.setContent(stripLeadingH1(note.doc), { emitUpdate: false })
  }, [editor, docEpoch, note?.id])

  if (!note || !editor) return null

  return (
    <div data-testid="editor" className="editor">
      <EditorToolbar editor={editor} openLinkRef={openLinkRef} />
      <EditorContent editor={editor} />
    </div>
  )
})
