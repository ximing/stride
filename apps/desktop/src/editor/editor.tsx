import type { TipTapNode } from '@stride/core/note'
import { isArchived, stripLeadingH1 } from '@stride/core/note'
import { EditorContent, useEditor } from '@tiptap/react'
import { useEffect, useMemo, useRef } from 'react'
import { observer, useService } from '@rabjs/react'
import { VaultService } from '../services/vault.service'
import { createEditorExtensions } from './extensions'
import { EditorToolbar } from './toolbar'
import { resolveWikilinkClick } from './wikilink'

const emptyDoc = { type: 'doc', content: [{ type: 'paragraph' }] }

export const NoteEditor = observer(function NoteEditor() {
  const vault = useService(VaultService)
  const note = vault.active
  const notes = vault.notes
  const openLinkRef = useRef<() => boolean>(() => true)
  const getNotesRef = useRef<() => { id: string; title: string }[]>(() => [])
  const onOpenRef = useRef<(target: string) => void>(() => {})
  getNotesRef.current = () => notes
    .filter((item) => item.type !== 'Type' && !isArchived(item))
    .map((item) => ({ id: item.id, title: item.title }))
  onOpenRef.current = (target) => {
    const action = resolveWikilinkClick(notes, target)
    if (action.type === 'select') vault.select(action.id)
    else void vault.createLinkedNote(action.title)
  }
  const extensions = useMemo(
    () => createEditorExtensions({
      onModK: () => openLinkRef.current(),
      getNotes: () => getNotesRef.current(),
      onOpen: (target) => onOpenRef.current(target),
    }),
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
  const linkableKey = notes
    .filter((item) => item.type !== 'Type' && !isArchived(item))
    .map((item) => `${item.id}\0${item.title}`)
    .join('\n')
  useEffect(() => {
    if (!editor || !note) return
    editor.commands.setContent(stripLeadingH1(note.doc), { emitUpdate: false })
  }, [editor, docEpoch, note?.id])
  useEffect(() => {
    if (!editor || editor.isDestroyed) return
    editor.view.dispatch(editor.state.tr.setMeta('addToHistory', false))
  }, [editor, linkableKey])

  if (!note || !editor) return null

  return (
    <div data-testid="editor" className="editor">
      <EditorToolbar editor={editor} openLinkRef={openLinkRef} />
      <EditorContent editor={editor} />
    </div>
  )
})
