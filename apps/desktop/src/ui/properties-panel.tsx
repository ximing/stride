import { Archive, SlidersHorizontal, Trash2, X } from 'lucide-react'
import { observer, useService } from '@rabjs/react'
import { relationsOf, resolveNote, type NoteRelations } from '@stride/core/graph'
import { bodyWikilinks, isArchived, isHiddenProperty, propertyKind, type StrideNote } from '@stride/core/note'
import { useState } from 'react'
import { TabsService } from '../services/tabs.service'
import { VaultService } from '../services/vault.service'
import { EmptyState } from './empty-state'
import { Button, IconButton } from './button'
import { Mark } from './icon'
import { Input } from './input'
import { Modal, ModalClose, ModalContent } from './modal'
import { Select } from './select'

function unresolvedRelations(
  note: StrideNote,
  notes: StrideNote[],
  outgoing: NoteRelations['outgoing'],
): { key: string; field: string; label: string }[] {
  const rows: { key: string; field: string; label: string }[] = []
  const seen = new Set<string>()
  const push = (field: string, label: string) => {
    const key = `${field}\0${label}`
    if (seen.has(key)) return
    seen.add(key)
    rows.push({ key, field, label })
  }
  for (const link of outgoing) {
    if (!link.resolvedId) push(link.field, link.target)
  }
  for (const target of bodyWikilinks(note.doc)) {
    if (!resolveNote(notes, target)) push('body', target)
  }
  return rows
}

const PROPERTY_TYPE_OPTIONS = [
  { value: 'string', label: 'string' },
  { value: 'number', label: 'number' },
  { value: 'boolean', label: 'boolean' },
  { value: 'list', label: 'list' },
]

export const PropertiesPanel = observer(function PropertiesPanel() {
  const vault = useService(VaultService)
  const tabs = useService(TabsService)
  const note = vault.active
  const [deleteOpen, setDeleteOpen] = useState(false)
  if (!note) {
    return (
      <EmptyState
        compact
        icon={SlidersHorizontal}
        title="Select a note"
        body="Properties, relationships and backlinks show here."
        testId="properties-empty"
      />
    )
  }
  const graph = vault.graph
  const relations = relationsOf(graph, note.id)
  const unresolved = unresolvedRelations(note, graph.notes, relations.outgoing)
  const fields = Object.keys(note.properties).filter((field) => !isHiddenProperty(field))
  return (
    <div className="properties-panel">
      <div className="properties-panel-head">
        <h2 className="panel-heading">Properties</h2>
        <div className="properties-actions">
          <Button
            size="sm"
            tone="secondary"
            icon={<Mark icon={Archive} size={14} />}
            data-testid="archive-note"
            onClick={() => vault.updateBooleanProperty('archived', !isArchived(note))}
          >
            {isArchived(note) ? 'Unarchive' : 'Archive'}
          </Button>
          <Button
            size="sm"
            tone="danger"
            icon={<Mark icon={Trash2} size={14} />}
            data-testid="delete-note"
            onClick={() => setDeleteOpen(true)}
          >
            Delete
          </Button>
        </div>
      </div>
      <Modal open={deleteOpen} onOpenChange={setDeleteOpen}>
        <ModalContent title="Delete note" description="Delete this note permanently? This cannot be undone.">
          <div className="sd-modal-actions">
            <ModalClose asChild>
              <Button tone="secondary" data-testid="cancel-delete">Cancel</Button>
            </ModalClose>
            <Button
              tone="danger"
              data-testid="confirm-delete"
              onClick={() => {
                void vault.deleteActiveNote()
                setDeleteOpen(false)
              }}
            >
              Delete
            </Button>
          </div>
        </ModalContent>
      </Modal>
      <Input label="Type" value={note.type} onChange={(event) => vault.updateType(event.target.value)} />
      {fields.map((field) => {
        const value = note.properties[field]
        const kind = propertyKind(value)
        return (
          <div className="field property-row" data-testid="property-field" data-name={field} key={field}>
            {kind === 'boolean' ? (
              <Input
                label={field}
                className="property-check"
                type="checkbox"
                checked={value === true}
                onChange={(event) => vault.updateBooleanProperty(field, event.target.checked)}
                onBlur={() => vault.blurProperty()}
              />
            ) : kind === 'number' ? (
              <Input
                label={field}
                type="number"
                step="any"
                value={vault.numberText(field)}
                onChange={(event) => vault.updateNumberProperty(field, event.target.value)}
                onBlur={() => vault.commitNumberProperty(field)}
              />
            ) : (
              <Input
                label={field}
                type="text"
                value={kind === 'list' ? vault.listText(field) : vault.propertyText(field)}
                onChange={(event) => {
                  if (kind === 'list') vault.updateListProperty(field, event.target.value)
                  else vault.updateProperty(field, event.target.value)
                }}
                onBlur={() => {
                  if (kind === 'list') vault.commitListProperty(field)
                  else vault.blurProperty()
                }}
              />
            )}
            <IconButton
              className="property-remove"
              data-testid="remove-property"
              icon={X}
              label={`Remove ${field}`}
              size="sm"
              onClick={() => {
                vault.removeProperty(field)
                vault.blurProperty()
              }}
            />
          </div>
        )
      })}
      <form
        className="property-add-form"
        onSubmit={(event) => {
          event.preventDefault()
          vault.addProperty()
        }}
      >
        <h3 className="panel-subheading">Add property</h3>
        <Input
          label="Name"
          data-testid="property-name"
          value={vault.propertyName}
          onChange={(event) => vault.setPropertyName(event.target.value)}
          placeholder="supports"
        />
        <Select
          label="Type"
          data-testid="property-type"
          value={vault.propertyType}
          onValueChange={(value) => vault.setPropertyType(value)}
          options={PROPERTY_TYPE_OPTIONS}
        />
        {vault.propertyType === 'boolean' ? (
          <Input
            label="Value"
            className="property-check"
            type="checkbox"
            data-testid="property-value"
            checked={vault.propertyChecked}
            onChange={(event) => vault.setPropertyChecked(event.target.checked)}
          />
        ) : (
          <Input
            label="Value"
            data-testid="property-value"
            type={vault.propertyType === 'number' ? 'number' : 'text'}
            step={vault.propertyType === 'number' ? 'any' : undefined}
            value={vault.propertyValue}
            onChange={(event) => vault.setPropertyValue(event.target.value)}
            placeholder={vault.propertyType === 'list' ? '[[Other note]] token' : '[[Other note]]'}
          />
        )}
        <Button className="property-add" size="sm" tone="secondary" type="submit" data-testid="add-property">
          Add field
        </Button>
      </form>
      <h2 className="panel-heading">Relationships</h2>
      {relations.shown.length === 0 && unresolved.length === 0 && (
        <EmptyState compact title="No relationships yet." testId="relationships-empty" />
      )}
      {relations.shown.map((link) => {
        const label = `${link.derived ? `${link.field} (derived)` : link.field}: ${link.label}`
        if (!link.targetId) {
          return (
            <p key={`${link.field}-${link.label}-${link.derived}`} className="meta">
              {label}
            </p>
          )
        }
        return (
          <button
            key={`${link.field}-${link.targetId}-${link.derived}`}
            type="button"
            className="meta relation-row"
            data-testid="relation-link"
            data-target={link.targetId}
            onClick={() => tabs.openNote(link.targetId)}
          >
            {label}
          </button>
        )
      })}
      {unresolved.map((link) => (
        <p key={link.key} className="meta">
          {link.field}: {link.label}
        </p>
      ))}
      <h2 className="panel-heading">Backlinks</h2>
      {relations.backlinks.length === 0 && <EmptyState compact title="No backlinks." testId="backlinks-empty" />}
      {relations.backlinks.map((link) => (
        <button
          key={`${link.sourceId}-${link.via}`}
          type="button"
          className="meta relation-row"
          data-testid="backlink"
          data-source={link.sourceId}
          onClick={() => {
            if (link.sourceId) tabs.openNote(link.sourceId)
          }}
        >
          {graph.byId.get(link.sourceId)?.title} · {link.via}
        </button>
      ))}
    </div>
  )
})
