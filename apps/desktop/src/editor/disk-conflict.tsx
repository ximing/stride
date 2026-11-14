import { observer, useService } from '@rabjs/react'
import { CircleAlert } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { keepDraftConflict, loadDiskConflict } from '../services/vault/vault-refresh'
import { VaultService } from '../services/vault/vault.service'
import { Button } from '../ui/primitives/button'
import { Mark } from '../ui/primitives/icon'
import './disk-conflict.css'

export const DiskConflictBanner = observer(function DiskConflictBanner() {
  const { t } = useTranslation()
  const vault = useService(VaultService)
  const id = vault.activeId
  const conflict = vault.diskConflicts.find((item) => item.id === id)
  if (!conflict) return null
  const message = conflict.note
    ? t('editor.diskConflict.changed')
    : conflict.mtimeMs === null
      ? t('editor.diskConflict.missing')
      : t('editor.diskConflict.tooLarge')
  return (
    <div className="edc" role="status" data-testid="editor-disk-conflict">
      <span className="edc-icon" aria-hidden="true">
        <Mark icon={CircleAlert} size={16} />
      </span>
      <p className="edc-text">{message}</p>
      <div className="edc-actions">
        <Button
          tone="primary"
          size="sm"
          data-testid="editor-disk-conflict-keep"
          onClick={() => {
            void keepDraftConflict(vault, id)
          }}
        >
          {t('editor.diskConflict.keep')}
        </Button>
        {conflict.note ? (
          <Button
            tone="secondary"
            size="sm"
            data-testid="editor-disk-conflict-load"
            onClick={() => {
              loadDiskConflict(vault, id)
            }}
          >
            {t('editor.diskConflict.load')}
          </Button>
        ) : null}
      </div>
    </div>
  )
})
