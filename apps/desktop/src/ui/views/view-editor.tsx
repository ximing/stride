import { observer, useService } from '@rabjs/react'
import { Plus, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { typeSidebarLabel } from '../../../../../packages/core/src/types'
import { VIEW_FILTER_OPS, type ViewFilterOp, type ViewSortDir, type ViewSortKey } from '../../../../../packages/core/src/views'
import { VaultService } from '../../services/vault/vault.service'
import { ViewsService } from '../../services/views/views.service'
import { Button, IconButton } from '../primitives/button'
import { Input } from '../primitives/input'
import { Modal, ModalClose, ModalContent } from '../primitives/modal'
import { Select } from '../primitives/select'

const SORT_OPTIONS: { key: ViewSortKey; dir: ViewSortDir; labelKey: 'notes.modifiedNewest' | 'notes.modifiedOldest' | 'notes.titleAz' | 'notes.titleZa' | 'notes.createdNewest' | 'notes.createdOldest' }[] = [
  { key: 'mtime', dir: 'desc', labelKey: 'notes.modifiedNewest' },
  { key: 'mtime', dir: 'asc', labelKey: 'notes.modifiedOldest' },
  { key: 'title', dir: 'asc', labelKey: 'notes.titleAz' },
  { key: 'title', dir: 'desc', labelKey: 'notes.titleZa' },
  { key: 'created', dir: 'desc', labelKey: 'notes.createdNewest' },
  { key: 'created', dir: 'asc', labelKey: 'notes.createdOldest' },
]

const OP_LABEL_KEYS: Record<ViewFilterOp, 'views.opEq' | 'views.opContains' | 'views.opExists'> = {
  eq: 'views.opEq',
  contains: 'views.opContains',
  exists: 'views.opExists',
}

const ANY_TYPE = '__any__'
const DEFAULT_SORT = '__default__'

/**
 * Editor for saved views (`views/*.json`). All state lives in
 * ViewsService.draft so the command palette (`view.saveCurrent`) and the
 * sidebar drive the same modal.
 */
export const ViewEditorModal = observer(function ViewEditorModal() {
  const { t } = useTranslation()
  const views = useService(ViewsService)
  const vault = useService(VaultService)
  const draft = views.draft
  const typeOptions = vault.sidebarTypes
  const sortOptions = [
    { value: DEFAULT_SORT, label: t('views.defaultSort') },
    ...SORT_OPTIONS.map(({ key, dir, labelKey }) => ({ value: `${key}:${dir}`, label: t(labelKey) })),
  ]
  const opOptions = VIEW_FILTER_OPS.map((op) => ({ value: op, label: t(OP_LABEL_KEYS[op]) }))
  return (
    <Modal open={draft !== null} onOpenChange={(open) => { if (!open) views.closeEditor() }}>
      <ModalContent
        title={draft && draft.file !== '' ? t('views.edit') : t('views.new')}
        description={t('views.description')}
      >
        {draft && (
          <div className="view-editor" data-testid="view-editor">
            <Input
              label={t('views.name')}
              data-testid="view-name"
              value={draft.name}
              onChange={(event) => views.updateDraft({ name: event.target.value })}
            />
            <Input
              label={t('views.icon')}
              data-testid="view-icon"
              value={draft.icon}
              onChange={(event) => views.updateDraft({ icon: event.target.value })}
            />
            <Select
              label={t('views.type')}
              data-testid="view-type"
              value={draft.type === '' ? ANY_TYPE : draft.type}
              onValueChange={(value) => views.updateDraft({ type: value === ANY_TYPE ? '' : value })}
              options={[
                { value: ANY_TYPE, label: t('views.anyType') },
                ...typeOptions.map((note) => ({ value: note.title, label: typeSidebarLabel(note) })),
                ...(draft.type !== '' && !typeOptions.some((note) => note.title === draft.type)
                  ? [{ value: draft.type, label: draft.type }]
                  : []),
              ]}
            />
            <Select
              label={t('views.sort')}
              data-testid="view-sort"
              value={draft.sortKey === '' ? DEFAULT_SORT : `${draft.sortKey}:${draft.sortDir}`}
              onValueChange={(value) => {
                if (value === DEFAULT_SORT) {
                  views.updateDraft({ sortKey: '' })
                  return
                }
                const [key, dir] = value.split(':') as [ViewSortKey, ViewSortDir]
                views.updateDraft({ sortKey: key, sortDir: dir })
              }}
              options={sortOptions}
            />
            <label className="advance-inbox view-archived">
              <input
                type="checkbox"
                data-testid="view-archived"
                checked={draft.archived}
                onChange={(event) => views.updateDraft({ archived: event.target.checked })}
              />
              {t('views.includeArchived')}
            </label>
            <div className="view-filters" data-testid="view-filters">
              <span className="sd-field-label">{t('views.filters')}</span>
              {draft.filters.map((filter, index) => (
                <div className="view-filter-row" data-testid="view-filter-row" key={index}>
                  <Input
                    aria-label={t('views.property')}
                    className="view-filter-key"
                    data-testid="view-filter-key"
                    placeholder={t('views.propertyPlaceholder')}
                    value={filter.key}
                    onChange={(event) => views.updateDraftFilter(index, { key: event.target.value })}
                  />
                  <Select
                    aria-label={t('views.operator')}
                    className="view-filter-op"
                    data-testid="view-filter-op"
                    value={filter.op}
                    onValueChange={(value) => views.updateDraftFilter(index, { op: value as ViewFilterOp })}
                    options={opOptions}
                  />
                  {filter.op !== 'exists' && (
                    <Input
                      aria-label={t('views.value')}
                      className="view-filter-value"
                      data-testid="view-filter-value"
                      placeholder={t('views.valuePlaceholder')}
                      value={filter.value}
                      onChange={(event) => views.updateDraftFilter(index, { value: event.target.value })}
                    />
                  )}
                  <IconButton
                    className="view-filter-remove"
                    data-testid="view-filter-remove"
                    icon={X}
                    label={t('views.remove')}
                    onClick={() => views.removeDraftFilter(index)}
                  />
                </div>
              ))}
              <Button
                tone="quiet"
                size="sm"
                className="view-filter-add"
                data-testid="view-filter-add"
                icon={<Plus aria-hidden="true" size={14} strokeWidth={1.75} />}
                onClick={() => views.addDraftFilter()}
              >
                {t('views.add')}
              </Button>
            </div>
            <div className="view-editor-actions">
              {draft.file !== '' && (
                <Button
                  tone="danger"
                  className="view-editor-delete"
                  data-testid="view-delete"
                  onClick={() => void views.deleteView(draft.file)}
                >
                  {t('common.delete')}
                </Button>
              )}
              <ModalClose asChild>
                <Button tone="quiet" className="view-editor-cancel" data-testid="view-cancel">{t('common.cancel')}</Button>
              </ModalClose>
              <Button tone="primary" className="view-editor-save" data-testid="view-save" onClick={() => void views.saveDraft()}>
                {t('views.save')}
              </Button>
            </div>
          </div>
        )}
      </ModalContent>
    </Modal>
  )
})
