import type { TipTapNode } from '@stride/core/note'
import { isArchived, plainText, stripLeadingH1 } from '@stride/core/note'
import { EditorContent, useEditor } from '@tiptap/react'
import { useEffect, useMemo, useRef } from 'react'
import { observer, useService } from '@rabjs/react'
import { TabsService } from '../services/tabs.service'
import { VaultService } from '../services/vault.service'
import { createEditorExtensions } from './extensions'
import { plainTextSelection } from './search-jump'
import { EditorFind } from './find-bar'
import { EditorToolbar } from './toolbar'
import { resolveWikilinkClick } from './wikilink'

const emptyDoc = { type: 'doc', content: [{ type: 'paragraph' }] }

export const NoteEditor = observer(function NoteEditor() {
  const vault = useService(VaultService)
  const tabs = useService(TabsService)
  const note = vault.active
  const notes = vault.notes
  const openLinkRef = useRef<() => boolean>(() => true)
  const getNotesRef = useRef<() => { id: string; title: string }[]>(() => [])
  const onOpenRef = useRef<(target: string) => void>(() => {})
  const fsRef = useRef(vault.fs)
  fsRef.current = vault.fs
  getNotesRef.current = () => notes
    .filter((item) => item.type !== 'Type' && !isArchived(item))
    .map((item) => ({ id: item.id, title: item.title }))
  onOpenRef.current = (target) => {
    const action = resolveWikilinkClick(notes, target)
    // Wikilinks navigate inside the active tab (pushing its history); every
    // other entry point goes through TabsService.openNote.
    if (action.type === 'select') tabs.followLink(action.id)
    else void vault.createLinkedNote(action.title)
  }
  const extensions = useMemo(
    () => createEditorExtensions({
      getNotes: () => getNotesRef.current(),
      onOpen: (target) => onOpenRef.current(target),
      getFs: () => fsRef.current,
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
  useEffect(() => {
    if (!editor) return
    const onJump = (event: Event) => {
      if (!(event instanceof CustomEvent)) return
      const detail = event.detail as { offset?: unknown; length?: unknown } | null
      if (!detail || typeof detail.offset !== 'number' || !Number.isFinite(detail.offset)) return
      const length = typeof detail.length === 'number' && Number.isFinite(detail.length) ? detail.length : 0
      const stored = plainText(vault.active?.doc ?? { type: 'doc' })
      const range = plainTextSelection(editor.state.doc, stored, detail.offset, length)
      if (!range || editor.isDestroyed) return
      try {
        editor.chain().focus().setTextSelection(range).scrollIntoView().run()
      } catch {
        return
      }
    }
    window.addEventListener('stride-search-jump', onJump)
    return () => window.removeEventListener('stride-search-jump', onJump)
  }, [editor, vault])

  if (!note || !editor) return null

  return (
    <div data-testid="editor" className="editor">
      <EditorFind editor={editor} />
      <EditorToolbar editor={editor} openLinkRef={openLinkRef} />
      <EditorContent editor={editor} />
    </div>
  )
})
