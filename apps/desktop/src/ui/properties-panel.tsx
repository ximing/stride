import { observer, useService } from '@rabjs/react'
import { relationsOf, resolveNote, type NoteRelations } from '@stride/core/graph'
import { bodyWikilinks, isArchived, isHiddenProperty, propertyKind, type StrideNote } from '@stride/core/note'
import { useState } from 'react'
import { VaultService } from '../services/vault.service'
import { Modal, ModalClose, ModalContent } from './modal'

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

export const PropertiesPanel = observer(function PropertiesPanel() {
  const vault = useService(VaultService)
  const note = vault.active
  const [deleteOpen, setDeleteOpen] = useState(false)
  if (!note) return <p className="empty-note">Select a note.</p>
  const graph = vault.graph
  const relations = relationsOf(graph, note.id)
  const unresolved = unresolvedRelations(note, graph.notes, relations.outgoing)
  const fields = Object.keys(note.properties).filter((field) => !isHiddenProperty(field))
  return (
    <div>
      <button
        type="button"
        data-testid="archive-note"
        onClick={() => vault.updateBooleanProperty('archived', !isArchived(note))}
      >
        {isArchived(note) ? 'Unarchive' : 'Archive'}
      </button>
      <button type="button" data-testid="delete-note" onClick={() => setDeleteOpen(true)}>
        Delete
      </button>
      <Modal open={deleteOpen} onOpenChange={setDeleteOpen}>
        <ModalContent title="Delete note" description="Delete this note permanently? This cannot be undone.">
          <button
            type="button"
            data-testid="confirm-delete"
            onClick={() => {
              void vault.deleteActiveNote()
              setDeleteOpen(false)
            }}
          >
            Delete
          </button>
          <ModalClose data-testid="cancel-delete">Cancel</ModalClose>
        </ModalContent>
      </Modal>
      <h2>Properties</h2>
      <label className="field">
        <span>Type</span>
        <input value={note.type} onChange={(event) => vault.updateType(event.target.value)} />
      </label>
      {fields.map((field) => {
        const value = note.properties[field]
        const kind = propertyKind(value)
        return (
          <div className="field property-row" data-testid="property-field" data-name={field} key={field}>
            <label>
              <span>{field}</span>
              {kind === 'boolean' ? (
                <input
                  className="property-check"
                  type="checkbox"
                  checked={value === true}
                  onChange={(event) => vault.updateBooleanProperty(field, event.target.checked)}
                  onBlur={() => vault.blurProperty()}
                />
              ) : kind === 'number' ? (
                <input
                  type="number"
                  step="any"
                  value={vault.numberText(field)}
                  onChange={(event) => vault.updateNumberProperty(field, event.target.value)}
                  onBlur={() => vault.commitNumberProperty(field)}
                />
              ) : (
                <input
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
            </label>
            <button
              type="button"
              data-testid="remove-property"
              onClick={() => {
                vault.removeProperty(field)
                vault.blurProperty()
              }}
            >
              Remove
            </button>
          </div>
        )
      })}
      <form
        onSubmit={(event) => {
          event.preventDefault()
          vault.addProperty()
        }}
      >
        <label className="field">
          <span>Name</span>
          <input
            data-testid="property-name"
            value={vault.propertyName}
            onChange={(event) => vault.setPropertyName(event.target.value)}
            placeholder="supports"
          />
        </label>
        <label className="field">
          <span>Type</span>
          <select
            data-testid="property-type"
            value={vault.propertyType}
            onChange={(event) => vault.setPropertyType(event.target.value)}
          >
            <option value="string">string</option>
            <option value="number">number</option>
            <option value="boolean">boolean</option>
            <option value="list">list</option>
          </select>
        </label>
        <label className="field">
          <span>Value</span>
          {vault.propertyType === 'boolean' ? (
            <input
              className="property-check"
              type="checkbox"
              data-testid="property-value"
              checked={vault.propertyChecked}
              onChange={(event) => vault.setPropertyChecked(event.target.checked)}
            />
          ) : (
            <input
              data-testid="property-value"
              type={vault.propertyType === 'number' ? 'number' : 'text'}
              step={vault.propertyType === 'number' ? 'any' : undefined}
              value={vault.propertyValue}
              onChange={(event) => vault.setPropertyValue(event.target.value)}
              placeholder={vault.propertyType === 'list' ? '[[Other note]] token' : '[[Other note]]'}
            />
          )}
        </label>
        <button type="submit" data-testid="add-property">Add field</button>
      </form>
      <h2>Relationships</h2>
      {relations.shown.length === 0 && unresolved.length === 0 && <p className="meta">No relationships yet.</p>}
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
            onClick={() => vault.select(link.targetId)}
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
      <h2>Backlinks</h2>
      {relations.backlinks.length === 0 && <p className="meta">No backlinks.</p>}
      {relations.backlinks.map((link) => (
        <button
          key={`${link.sourceId}-${link.via}`}
          type="button"
          className="meta relation-row"
          data-testid="backlink"
          data-source={link.sourceId}
          onClick={() => {
            if (link.sourceId) vault.select(link.sourceId)
          }}
        >
          {graph.byId.get(link.sourceId)?.title} · {link.via}
        </button>
      ))}
    </div>
  )
})
