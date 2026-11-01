import { register, resolve } from '@rabjs/react'
import { createNote, plainText } from '@stride/core/note'
import type { Editor } from '@tiptap/core'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { VaultService } from '../services/vault/vault.service'
import { NoteEditor } from './editor'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

it('does not reconfigure the editor view after each body edit', async () => {
  register(VaultService)
  const vault = resolve(VaultService)
  const note = createNote('typing', 'Typing')
  note.doc = { type: 'doc', content: Array.from({ length: 300 }, () => ({
    type: 'paragraph', content: [{ type: 'text', text: '中文 English paragraph' }],
  })) }
  vault.notes = [note]
  vault.activeId = note.id
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  try {
    await act(async () => { root.render(<NoteEditor />) })
    const editor = (host.querySelector('.tiptap') as HTMLElement & { editor: Editor }).editor
    const configure = vi.spyOn(editor, 'setOptions')
    for (const text of ['a', '中', 'b', '文']) {
      await act(async () => { editor.commands.insertContent(text) })
    }
    expect(plainText(vault.active!.doc)).toContain('a中b文')
    expect(configure).not.toHaveBeenCalled()
    await act(async () => { editor.commands.undo() })
    expect(plainText(vault.active!.doc)).not.toContain('a中b文')
    await act(async () => { editor.commands.redo() })
    expect(plainText(vault.active!.doc)).toContain('a中b文')

    const other = createNote('other', 'Other')
    other.doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Second note' }] }] }
    await act(async () => {
      vault.cancelPending()
      vault.notes = [...vault.notes, other]
      vault.activeId = other.id
    })
    expect(editor.getText()).toBe('Second note')
    await act(async () => {
      vault.replace({ ...other, doc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'External update' }] }] } })
      vault.docEpoch += 1
    })
    expect(editor.getText()).toBe('External update')
  } finally {
    vault.cancelPending()
    await act(async () => root.unmount())
    host.remove()
    vi.restoreAllMocks()
  }
})
