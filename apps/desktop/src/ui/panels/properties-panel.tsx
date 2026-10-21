import { Archive, SlidersHorizontal, Trash2, X } from 'lucide-react'
import { observer, useService } from '@rabjs/react'
import { useTranslation } from 'react-i18next'
import { relationsOf, resolveNote, type NoteRelations } from '@stride/core/graph'
import { bodyWikilinks, isArchived, isHiddenProperty, propertyKind, type StrideNote } from '@stride/core/note'
import { useState } from 'react'
import { TabsService } from '../../services/notes/tabs.service'
import { VaultService } from '../../services/vault/vault.service'
import { EmptyState } from '../primitives/empty-state'
import { Button, IconButton } from '../primitives/button'
import { Mark } from '../primitives/icon'
import { Input } from '../primitives/input'
import { Modal, ModalClose, ModalContent } from '../primitives/modal'
import { Select } from '../primitives/select'

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
  const { t } = useTranslation()
  const vault = useService(VaultService)
  const tabs = useService(TabsService)
  const note = vault.active
  const [deleteOpen, setDeleteOpen] = useState(false)
  const propertyTypeOptions = [
    { value: 'string', label: t('panels.kindString') },
    { value: 'number', label: t('panels.kindNumber') },
    { value: 'boolean', label: t('panels.kindBoolean') },
    { value: 'list', label: t('panels.kindList') },
  ]
  if (!note) {
    return (
      <EmptyState
        compact
        icon={SlidersHorizontal}
        title={t('panels.propertiesEmptyTitle')}
        body={t('panels.propertiesEmptyBody')}
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
        <h2 className="panel-heading">{t('panels.properties')}</h2>
        <div className="properties-actions">
          <Button
            size="sm"
            tone="secondary"
            icon={<Mark icon={Archive} size={14} />}
            data-testid="archive-note"
            onClick={() => vault.updateBooleanProperty('archived', !isArchived(note))}
          >
            {isArchived(note) ? t('panels.unarchive') : t('notes.archive')}
          </Button>
          <Button
            size="sm"
            tone="danger"
            icon={<Mark icon={Trash2} size={14} />}
            data-testid="delete-note"
            onClick={() => setDeleteOpen(true)}
          >
            {t('common.delete')}
          </Button>
        </div>
      </div>
      <Modal open={deleteOpen} onOpenChange={setDeleteOpen}>
        <ModalContent title={t('panels.deleteNote')} description={t('panels.deleteNoteBody')}>
          <div className="sd-modal-actions">
            <ModalClose asChild>
              <Button tone="secondary" data-testid="cancel-delete">{t('common.cancel')}</Button>
            </ModalClose>
            <Button
              tone="danger"
              data-testid="confirm-delete"
              onClick={() => {
                void vault.deleteActiveNote()
                setDeleteOpen(false)
              }}
            >
              {t('common.delete')}
            </Button>
          </div>
        </ModalContent>
      </Modal>
      <Input label={t('panels.type')} value={note.type} onChange={(event) => vault.updateType(event.target.value)} />
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
              label={t('panels.remove', { name: field })}
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
        <h3 className="panel-subheading">{t('panels.addProperty')}</h3>
        <Input
          label={t('panels.relationName')}
          data-testid="property-name"
          value={vault.propertyName}
          onChange={(event) => vault.setPropertyName(event.target.value)}
          placeholder={t('panels.relationNamePlaceholder')}
        />
        <Select
          label={t('panels.relationType')}
          data-testid="property-type"
          value={vault.propertyType}
          onValueChange={(value) => vault.setPropertyType(value)}
          options={propertyTypeOptions}
        />
        {vault.propertyType === 'boolean' ? (
          <Input
            label={t('panels.relationValue')}
            className="property-check"
            type="checkbox"
            data-testid="property-value"
            checked={vault.propertyChecked}
            onChange={(event) => vault.setPropertyChecked(event.target.checked)}
          />
        ) : (
          <Input
            label={t('panels.relationValue')}
            data-testid="property-value"
            type={vault.propertyType === 'number' ? 'number' : 'text'}
            step={vault.propertyType === 'number' ? 'any' : undefined}
            value={vault.propertyValue}
            onChange={(event) => vault.setPropertyValue(event.target.value)}
            placeholder={vault.propertyType === 'list' ? t('panels.valueList') : t('panels.valueNote')}
          />
        )}
        <Button className="property-add" size="sm" tone="secondary" type="submit" data-testid="add-property">
          {t('panels.addField')}
        </Button>
      </form>
      <h2 className="panel-heading">{t('panels.relationships')}</h2>
      {relations.shown.length === 0 && unresolved.length === 0 && (
        <EmptyState compact title={t('panels.noRelations')} testId="relationships-empty" />
      )}
      {relations.shown.map((link) => {
        const fieldLabel = link.derived ? t('panels.derived', { field: link.field }) : link.field
        const label = `${fieldLabel}: ${link.label}`
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
      <h2 className="panel-heading">{t('panels.backlinks')}</h2>
      {relations.backlinks.length === 0 && <EmptyState compact title={t('panels.noBacklinks')} testId="backlinks-empty" />}
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
