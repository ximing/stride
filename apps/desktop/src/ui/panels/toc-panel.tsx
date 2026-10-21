import { ListTree } from 'lucide-react'
import type { Editor } from '@tiptap/core'
import { observer, useService } from '@rabjs/react'
import { useTranslation } from 'react-i18next'
import { VaultService } from '../../services/vault/vault.service'
import { EmptyState } from '../primitives/empty-state'
import { tocItems, type TocItem } from './toc'

function focusTitle() {
  document.querySelector<HTMLElement>('[data-testid="note-title"]')?.focus()
}

function editorOnSurface(): Editor | null {
  const surface = document.querySelector('.ProseMirror')
  if (!surface) return null
  const editor = (surface as HTMLElement & { editor?: Editor }).editor
  if (!editor || editor.isDestroyed) return null
  return editor
}

function openHeading(pos: number) {
  const editor = editorOnSurface()
  if (!editor) return
  editor.chain().setTextSelection(pos).scrollIntoView().run()
}

function openItem(item: TocItem) {
  if (item.level === 1) {
    focusTitle()
    return
  }
  openHeading(item.pos)
}

export const TocPanel = observer(function TocPanel() {
  const { t } = useTranslation()
  const vault = useService(VaultService)
  const note = vault.active
  if (!note) {
    return (
      <div className="toc-panel" data-testid="toc-panel">
        <EmptyState
          compact
          icon={ListTree}
          title={t('panels.tocEmptyTitle')}
          body={t('panels.tocEmptyBody')}
          testId="toc-empty"
        />
      </div>
    )
  }
  const items = tocItems(note.title, note.doc)
  // tocItems always leads with the title (level 1); only title means no headings.
  if (items.length <= 1) {
    return (
      <div className="toc-panel" data-testid="toc-panel">
        <EmptyState
          compact
          icon={ListTree}
          title={t('panels.tocNoneTitle')}
          body={t('panels.tocNoneBody')}
          testId="toc-empty-headings"
        />
      </div>
    )
  }
  return (
    <div className="toc-panel" data-testid="toc-panel">
      <h2 className="panel-heading">{t('panels.outline')}</h2>
      <div className="toc-list">
        {items.map((item, index) => (
          <button
            key={`${item.level}-${item.pos}-${index}`}
            type="button"
            className="toc-item"
            data-testid="toc-item"
            data-level={item.level}
            onClick={() => openItem(item)}
          >
            {item.text}
          </button>
        ))}
      </div>
    </div>
  )
})
