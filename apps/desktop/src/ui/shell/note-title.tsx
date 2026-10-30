import { observer, useService } from '@rabjs/react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { VaultService } from '../../services/vault/vault.service'

type TitleDraft = { id: string; value: string }

/** Title field. Keystrokes stay local until Enter or blur, so clearing the
 * box cannot autosave the Untitled sentinel over the previous name. */
export const NoteTitleField = observer(function NoteTitleField() {
  const { t } = useTranslation()
  const vault = useService(VaultService)
  const note = vault.active
  const noteId = note?.id ?? ''
  const [draft, setDraft] = useState<TitleDraft | null>(null)
  const draftRef = useRef<TitleDraft | null>(null)

  function remember(next: TitleDraft | null) {
    draftRef.current = next
    setDraft(next)
  }

  function takeDraft(): TitleDraft | null {
    const pending = draftRef.current
    remember(null)
    return pending
  }

  useEffect(() => {
    const pending = draftRef.current
    if (!pending || pending.id === noteId) return
    draftRef.current = null
    setDraft(null)
    void vault.commitTitleDraft(pending.id, pending.value)
  }, [noteId, vault])

  if (!note) return null
  const shown = draft && draft.id === note.id ? draft.value : note.title

  return (
    <input
      className="note-title"
      data-testid="note-title"
      aria-label={t('notes.titleLabel')}
      placeholder={t('notes.untitled')}
      value={shown}
      onChange={(event) => remember({ id: note.id, value: event.target.value })}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          remember(null)
          event.currentTarget.blur()
          return
        }
        if (event.key === 'Enter') {
          event.preventDefault()
          event.stopPropagation()
          event.currentTarget.blur()
        }
      }}
      onBlur={() => {
        const pending = takeDraft()
        if (pending) void vault.commitTitleDraft(pending.id, pending.value)
        else void vault.commitHeadingRename()
      }}
    />
  )
})
