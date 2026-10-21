import { observer, useService } from '@rabjs/react'
import { Plus, X } from 'lucide-react'
import { typeSidebarLabel } from '../../../../../packages/core/src/types'
import { VIEW_FILTER_OPS, type ViewFilterOp, type ViewSortDir, type ViewSortKey } from '../../../../../packages/core/src/views'
import { VaultService } from '../../services/vault/vault.service'
import { ViewsService } from '../../services/views/views.service'
import { Button, IconButton } from '../primitives/button'
import { Input } from '../primitives/input'
import { Modal, ModalClose, ModalContent } from '../primitives/modal'
import { Select } from '../primitives/select'

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

const SORT_SELECT_OPTIONS = [
  { value: '__default__', label: 'Default (manual sort)' },
  ...SORT_OPTIONS.map(({ key, dir }) => ({ value: `${key}:${dir}`, label: SORT_LABELS[key][dir] })),
]

const OP_LABELS: Record<ViewFilterOp, string> = {
  eq: 'is',
  contains: 'contains',
  exists: 'exists',
}

const OP_OPTIONS = VIEW_FILTER_OPS.map((op) => ({ value: op, label: OP_LABELS[op] }))
const ANY_TYPE = '__any__'
const DEFAULT_SORT = '__default__'

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
            <Select
              label="Type"
              data-testid="view-type"
              value={draft.type === '' ? ANY_TYPE : draft.type}
              onValueChange={(value) => views.updateDraft({ type: value === ANY_TYPE ? '' : value })}
              options={[
                { value: ANY_TYPE, label: 'Any type' },
                ...typeOptions.map((note) => ({ value: note.title, label: typeSidebarLabel(note) })),
                ...(draft.type !== '' && !typeOptions.some((note) => note.title === draft.type)
                  ? [{ value: draft.type, label: draft.type }]
                  : []),
              ]}
            />
            <Select
              label="Sort"
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
              options={SORT_SELECT_OPTIONS}
            />
            <label className="advance-inbox view-archived">
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
                  <Input
                    aria-label="Property"
                    className="view-filter-key"
                    data-testid="view-filter-key"
                    placeholder="property"
                    value={filter.key}
                    onChange={(event) => views.updateDraftFilter(index, { key: event.target.value })}
                  />
                  <Select
                    aria-label="Filter operator"
                    className="view-filter-op"
                    data-testid="view-filter-op"
                    value={filter.op}
                    onValueChange={(value) => views.updateDraftFilter(index, { op: value as ViewFilterOp })}
                    options={OP_OPTIONS}
                  />
                  {filter.op !== 'exists' && (
                    <Input
                      aria-label="Filter value"
                      className="view-filter-value"
                      data-testid="view-filter-value"
                      placeholder="value"
                      value={filter.value}
                      onChange={(event) => views.updateDraftFilter(index, { value: event.target.value })}
                    />
                  )}
                  <IconButton
                    className="view-filter-remove"
                    data-testid="view-filter-remove"
                    icon={X}
                    label="Remove filter"
                    onClick={() => views.removeDraftFilter(index)}
                  />
                </div>
              ))}
              <Button
                tone="secondary"
                size="sm"
                className="view-filter-add"
                data-testid="view-filter-add"
                icon={<Plus aria-hidden="true" size={14} strokeWidth={1.75} />}
                onClick={() => views.addDraftFilter()}
              >
                Add filter
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
                  Delete
                </Button>
              )}
              <ModalClose asChild>
                <Button tone="secondary" className="view-editor-cancel" data-testid="view-cancel">Cancel</Button>
              </ModalClose>
              <Button tone="primary" className="view-editor-save" data-testid="view-save" onClick={() => void views.saveDraft()}>
                Save view
              </Button>
            </div>
          </div>
        )}
      </ModalContent>
    </Modal>
  )
})
