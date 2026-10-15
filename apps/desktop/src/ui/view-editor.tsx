import { observer, useService } from '@rabjs/react'
import { typeSidebarLabel } from '../../../../packages/core/src/types'
import { VIEW_FILTER_OPS, type ViewFilterOp, type ViewSortDir, type ViewSortKey } from '../../../../packages/core/src/views'
import { VaultService } from '../services/vault.service'
import { ViewsService } from '../services/views.service'
import { Button } from './button'
import { Input } from './input'
import { Modal, ModalClose, ModalContent } from './modal'

const SORT_LABELS: Record<ViewSortKey, Record<ViewSortDir, string>> = {
  mtime: { desc: 'Modified: newest first', asc: 'Modified: oldest first' },
  title: { asc: 'Title A–Z', desc: 'Title Z–A' },
  created: { desc: 'Created: newest first', asc: 'Created: oldest first' },
}

const SORT_OPTIONS: { key: ViewSortKey; dir: ViewSortDir }[] = [
  { key: 'mtime', dir: 'desc' },
  { key: 'mtime', dir: 'asc' },
  { key: 'title', dir: 'asc' },
  { key: 'title', dir: 'desc' },
  { key: 'created', dir: 'desc' },
  { key: 'created', dir: 'asc' },
]

const OP_LABELS: Record<ViewFilterOp, string> = {
  eq: 'is',
  contains: 'contains',
  exists: 'exists',
}

/**
 * Editor for saved views (`views/*.json`). All state lives in
 * ViewsService.draft so the command palette (`view.saveCurrent`) and the
 * sidebar drive the same modal.
 */
export const ViewEditorModal = observer(function ViewEditorModal() {
  const views = useService(ViewsService)
  const vault = useService(VaultService)
  const draft = views.draft
  const typeOptions = vault.sidebarTypes
  return (
    <Modal open={draft !== null} onOpenChange={(open) => { if (!open) views.closeEditor() }}>
      <ModalContent
        title={draft && draft.file !== '' ? 'Edit view' : 'New view'}
        description="A saved view filters the note list by type and properties, with its own optional sort."
      >
        {draft && (
          <div className="view-editor" data-testid="view-editor">
            <Input
              label="Name"
              data-testid="view-name"
              value={draft.name}
              onChange={(event) => views.updateDraft({ name: event.target.value })}
            />
            <Input
              label="Icon (optional)"
              data-testid="view-icon"
              value={draft.icon}
              onChange={(event) => views.updateDraft({ icon: event.target.value })}
            />
            <label className="sd-field">
              <span className="sd-field-label">Type</span>
              <select
                className="sd-field-input"
                data-testid="view-type"
                value={draft.type}
                onChange={(event) => views.updateDraft({ type: event.target.value })}
              >
                <option value="">Any type</option>
                {typeOptions.map((note) => (
                  <option key={note.id} value={note.title}>{typeSidebarLabel(note)}</option>
                ))}
                {draft.type !== '' && !typeOptions.some((note) => note.title === draft.type) && (
                  <option value={draft.type}>{draft.type}</option>
                )}
              </select>
            </label>
            <label className="sd-field">
              <span className="sd-field-label">Sort</span>
              <select
                className="sd-field-input"
                data-testid="view-sort"
                value={draft.sortKey === '' ? '' : `${draft.sortKey}:${draft.sortDir}`}
                onChange={(event) => {
                  const value = event.target.value
                  if (value === '') {
                    views.updateDraft({ sortKey: '' })
                    return
                  }
                  const [key, dir] = value.split(':') as [ViewSortKey, ViewSortDir]
                  views.updateDraft({ sortKey: key, sortDir: dir })
                }}
              >
                <option value="">Default (manual sort)</option>
                {SORT_OPTIONS.map(({ key, dir }) => (
                  <option key={`${key}-${dir}`} value={`${key}:${dir}`}>{SORT_LABELS[key][dir]}</option>
                ))}
              </select>
            </label>
            <label className="advance-inbox">
              <input
                type="checkbox"
                data-testid="view-archived"
                checked={draft.archived}
                onChange={(event) => views.updateDraft({ archived: event.target.checked })}
              />
              Include archived notes
            </label>
            <div className="view-filters" data-testid="view-filters">
              <span className="sd-field-label">Property filters</span>
              {draft.filters.map((filter, index) => (
                <div className="view-filter-row" data-testid="view-filter-row" key={index}>
                  <input
                    className="sd-field-input"
                    data-testid="view-filter-key"
                    placeholder="property"
                    value={filter.key}
                    onChange={(event) => views.updateDraftFilter(index, { key: event.target.value })}
                  />
                  <select
                    className="sd-field-input"
                    data-testid="view-filter-op"
                    value={filter.op}
                    onChange={(event) => views.updateDraftFilter(index, { op: event.target.value as ViewFilterOp })}
                  >
                    {VIEW_FILTER_OPS.map((op) => (
                      <option key={op} value={op}>{OP_LABELS[op]}</option>
                    ))}
                  </select>
                  {filter.op !== 'exists' && (
                    <input
                      className="sd-field-input"
                      data-testid="view-filter-value"
                      placeholder="value"
                      value={filter.value}
                      onChange={(event) => views.updateDraftFilter(index, { value: event.target.value })}
                    />
                  )}
                  <button
                    type="button"
                    className="view-filter-remove"
                    data-testid="view-filter-remove"
                    aria-label="Remove filter"
                    onClick={() => views.removeDraftFilter(index)}
                  >
                    ×
                  </button>
                </div>
              ))}
              <button type="button" data-testid="view-filter-add" onClick={() => views.addDraftFilter()}>
                Add filter
              </button>
            </div>
            <div className="view-editor-actions">
              <Button tone="primary" data-testid="view-save" onClick={() => void views.saveDraft()}>
                Save view
              </Button>
              {draft.file !== '' && (
                <Button tone="danger" data-testid="view-delete" onClick={() => void views.deleteView(draft.file)}>
                  Delete
                </Button>
              )}
              <ModalClose data-testid="view-cancel">Cancel</ModalClose>
            </div>
          </div>
        )}
      </ModalContent>
    </Modal>
  )
})
