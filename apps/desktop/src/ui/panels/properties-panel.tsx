import { Archive, GripVertical, MoreHorizontal, Plus, SlidersHorizontal, Trash2, X } from 'lucide-react'
import { observer, useService } from '@rabjs/react'
import { useTranslation } from 'react-i18next'
import {
  isManagedRelation,
  relationsOf,
  resolveNote,
  structuralRelation,
  type NoteRelations,
  type StructuralRelation,
} from '@stride/core/graph'
import {
  bodyWikilinks,
  isArchived,
  isHiddenProperty,
  propertyKind,
  type PropertyKind,
  type StrideNote,
} from '@stride/core/note'
import { useState } from 'react'
import { TabsService } from '../../services/notes/tabs.service'
import { VaultService } from '../../services/vault/vault.service'
import { EmptyState } from '../primitives/empty-state'
import { Button, IconButton } from '../primitives/button'
import { Checkbox } from '../primitives/checkbox'
import { Mark } from '../primitives/icon'
import { Input } from '../primitives/input'
import { Menu, MenuContent, MenuItem, MenuTrigger } from '../primitives/menu'
import { Modal, ModalClose, ModalContent } from '../primitives/modal'
import { Select } from '../primitives/select'
import { ListEditor } from './list-editor'

const RELATION_MATCH_LIMIT = 8

const KIND_LABEL_KEYS = {
  string: 'panels.kindString',
  number: 'panels.kindNumber',
  boolean: 'panels.kindBoolean',
  list: 'panels.kindList',
} as const

const PROPERTY_KINDS = Object.keys(KIND_LABEL_KEYS) as PropertyKind[]

type RelationGroup = 'belongs_to' | 'related_to' | 'body'

function RelationEditor({ noteId }: { noteId: string }) {
  const { t } = useTranslation()
  const vault = useService(VaultService)
  const [kind, setKind] = useState<StructuralRelation>('belongs_to')
  const [query, setQuery] = useState('')
  const [activeMatch, setActiveMatch] = useState(-1)
  const trimmed = query.trim().toLowerCase()
  const matches = trimmed
    ? vault.notes
      .filter((item) => item.id !== noteId && !isArchived(item) && item.title.toLowerCase().includes(trimmed))
      .slice(0, RELATION_MATCH_LIMIT)
    : []
  const add = (targetId: string) => {
    vault.linkRelation(kind, targetId)
    setQuery('')
    setActiveMatch(-1)
  }
  return (
    <form
      className="relation-add-form"
      onSubmit={(event) => {
        event.preventDefault()
        const pick = matches[activeMatch] ?? matches[0]
        if (pick) add(pick.id)
      }}
    >
      <Select
        label={t('panels.relationKind')}
        data-testid="relation-kind"
        value={kind}
        onValueChange={(value) => {
          if (value === 'belongs_to' || value === 'related_to') setKind(value)
        }}
        options={[
          { value: 'belongs_to', label: t('panels.belongsTo') },
          { value: 'related_to', label: t('panels.relatedTo') },
        ]}
      />
      <Input
        label={t('panels.relationNote')}
        data-testid="relation-query"
        value={query}
        placeholder={t('panels.relationSearch')}
        spellCheck={false}
        onChange={(event) => {
          setQuery(event.target.value)
          setActiveMatch(-1)
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault()
            setActiveMatch((index) => Math.min(index + 1, matches.length - 1))
          } else if (event.key === 'ArrowUp') {
            event.preventDefault()
            setActiveMatch((index) => Math.max(index - 1, -1))
          }
        }}
      />
      {matches.length > 0 ? (
        <div className="relation-matches">
          {matches.map((item, index) => (
            <button
              key={item.id}
              type="button"
              className={['relation-match', index === activeMatch ? 'is-active' : undefined].filter(Boolean).join(' ')}
              data-testid="relation-match"
              data-target={item.id}
              onMouseEnter={() => setActiveMatch(index)}
              onClick={() => add(item.id)}
            >
              {item.title}
            </button>
          ))}
        </div>
      ) : null}
    </form>
  )
}

function RelationLine({
  label,
  field,
  names,
  targetId,
  removable,
  onOpen,
  onCreate,
}: {
  label: string
  field: string
  names: string[]
  targetId?: string
  removable: boolean
  onOpen?: () => void
  onCreate?: () => void
}) {
  const { t } = useTranslation()
  const vault = useService(VaultService)
  return (
    <div className="relation-line">
      {targetId ? (
        <button
          type="button"
          className="meta relation-row"
          data-testid="relation-link"
          data-target={targetId}
          onClick={onOpen}
        >
          {label}
        </button>
      ) : (
        <p className="meta">{label}</p>
      )}
      {onCreate ? (
        <IconButton
          className="relation-create"
          data-testid="relation-create"
          data-field={field}
          icon={Plus}
          label={t('panels.createAndLink', { name: names[0] || label })}
          size="sm"
          onClick={onCreate}
        />
      ) : null}
      {removable ? (
        <IconButton
          className="property-remove"
          data-testid="relation-remove"
          data-field={field}
          icon={X}
          label={t('panels.remove', { name: names[0] || field })}
          size="sm"
          onClick={() => vault.unlinkRelation(field, names)}
        />
      ) : null}
    </div>
  )
}

function unresolvedRelations(
  note: StrideNote,
  notes: StrideNote[],
  outgoing: NoteRelations['outgoing'],
): { key: string; field: string; label: string }[] {
  const rows: { key: string; field: string; label: string }[] = []
  const seen = new Set<string>()
  const push = (field: string, label: string) => {
    const key = `${field}${label}`
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

/** Click-to-rename label: commits on Enter/blur, cancels on Escape. Invalid
 * names (empty, duplicate, `_`-prefixed) are rejected by the service and the
 * field simply keeps its old name. */
function PropertyName({ field }: { field: string }) {
  const { t } = useTranslation()
  const vault = useService(VaultService)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(field)
  if (editing) {
    const commit = () => {
      vault.renameProperty(field, draft)
      setEditing(false)
    }
    return (
      <Input
        ref={(element) => {
          if (element && document.activeElement !== element) {
            element.focus()
            element.select()
          }
        }}
        className="property-rename"
        data-testid="property-rename"
        value={draft}
        aria-label={t('panels.renameProperty', { name: field })}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            commit()
          } else if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            setDraft(field)
            setEditing(false)
          }
        }}
        onBlur={commit}
      />
    )
  }
  return (
    <button
      type="button"
      className="property-name"
      data-testid="property-rename-open"
      aria-label={t('panels.renameProperty', { name: field })}
      title={t('panels.renameProperty', { name: field })}
      onClick={() => {
        setDraft(field)
        setEditing(true)
      }}
    >
      {field}
    </button>
  )
}

const PropertyRow = observer(function PropertyRow({ field }: { field: string }) {
  const { t } = useTranslation()
  const vault = useService(VaultService)
  const note = vault.active
  if (!note) return null
  const value = note.properties[field]
  const kind = propertyKind(value)
  return (
    <div className="property-body">
      <div className="property-head">
        <PropertyName field={field} />
        <span className="property-tools">
          <Menu>
            <MenuTrigger asChild>
              <IconButton
                data-testid="property-actions"
                icon={MoreHorizontal}
                label={t('panels.propertyActions', { name: field })}
                size="sm"
              />
            </MenuTrigger>
            <MenuContent>
              {PROPERTY_KINDS.filter((target) => target !== kind).map((target) => (
                <MenuItem
                  key={target}
                  data-testid={`convert-to-${target}`}
                  onSelect={() => vault.convertProperty(field, target)}
                >
                  {t('panels.convertTo', { kind: t(KIND_LABEL_KEYS[target]) })}
                </MenuItem>
              ))}
            </MenuContent>
          </Menu>
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
        </span>
      </div>
      {kind === 'boolean' ? (
        <Checkbox
          className="property-check"
          checked={value === true}
          aria-label={field}
          onChange={(event) => vault.updateBooleanProperty(field, event.target.checked)}
          onBlur={() => vault.blurProperty()}
        />
      ) : kind === 'number' ? (
        <Input
          type="number"
          step="any"
          aria-label={field}
          value={vault.numberText(field)}
          onChange={(event) => vault.updateNumberProperty(field, event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              event.currentTarget.blur()
            } else if (event.key === 'Escape') {
              event.preventDefault()
              event.stopPropagation()
              vault.discardPropertyDraft(field)
              event.currentTarget.blur()
            }
          }}
          onBlur={() => vault.commitNumberProperty(field)}
        />
      ) : kind === 'list' ? (
        <ListEditor
          items={Array.isArray(value) ? value : []}
          placeholder={t('panels.listAdd')}
          onAdd={(item) => vault.addListItem(field, item)}
          onRemoveAt={(index) => vault.removeListItemAt(field, index)}
        />
      ) : (
        <Input
          type="text"
          aria-label={field}
          value={vault.propertyText(field)}
          onChange={(event) => vault.updateProperty(field, event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              event.currentTarget.blur()
            }
          }}
          onBlur={() => vault.blurProperty()}
        />
      )}
    </div>
  )
})

/** Property rows with HTML5 drag reorder: grab the grip, drop above or below a
 * sibling row (drop below the last row moves the field to the end). */
const PropertyFields = observer(function PropertyFields({ fields }: { fields: string[] }) {
  const { t } = useTranslation()
  const vault = useService(VaultService)
  const [dragField, setDragField] = useState<string | null>(null)
  const [dropAt, setDropAt] = useState<{ field: string; after: boolean } | null>(null)
  const finish = () => {
    setDragField(null)
    setDropAt(null)
  }
  return (
    <>
      {fields.map((field, index) => {
        const indicator = dropAt?.field === field ? (dropAt.after ? 'is-drop-after' : 'is-drop-before') : undefined
        return (
          <div
            className={['field', 'property-row', indicator].filter(Boolean).join(' ')}
            data-testid="property-field"
            data-name={field}
            key={field}
            onDragOver={(event) => {
              if (!dragField || dragField === field) return
              event.preventDefault()
              const rect = event.currentTarget.getBoundingClientRect()
              setDropAt({ field, after: event.clientY > rect.top + rect.height / 2 })
            }}
            onDragLeave={() => {
              if (dropAt?.field === field) setDropAt(null)
            }}
            onDrop={(event) => {
              event.preventDefault()
              if (dragField) {
                const after = dropAt?.field === field && dropAt.after
                vault.moveProperty(dragField, after ? fields[index + 1] ?? null : field)
              }
              finish()
            }}
          >
            <span
              className="property-grip"
              data-testid="property-grip"
              draggable
              aria-hidden
              title={t('panels.dragProperty', { name: field })}
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = 'move'
                event.dataTransfer.setData('text/plain', field)
                setDragField(field)
              }}
              onDragEnd={finish}
            >
              <Mark icon={GripVertical} size={14} />
            </span>
            <PropertyRow field={field} />
          </div>
        )
      })}
    </>
  )
})

/** Collapsed by default; expands inline. Duplicate and `_`-prefixed names are
 * flagged inline and block submission instead of silently overwriting. */
const AddPropertyForm = observer(function AddPropertyForm() {
  const { t } = useTranslation()
  const vault = useService(VaultService)
  const noteId = vault.active?.id ?? ''
  const [openFor, setOpenFor] = useState(noteId)
  const [open, setOpen] = useState(false)
  if (openFor !== noteId) {
    setOpenFor(noteId)
    setOpen(false)
  }
  const propertyTypeOptions = PROPERTY_KINDS.map((kind) => ({ value: kind, label: t(KIND_LABEL_KEYS[kind]) }))
  if (!open) {
    return (
      <Button
        size="sm"
        tone="quiet"
        icon={<Mark icon={Plus} size={14} />}
        data-testid="add-property-open"
        onClick={() => setOpen(true)}
      >
        {t('panels.addProperty')}
      </Button>
    )
  }
  const name = vault.propertyName.trim()
  const note = vault.active
  const exists = !!note && name.length > 0 && Object.hasOwn(note.properties, name)
  const hidden = name.startsWith('_')
  const error = exists ? t('panels.propertyExists') : hidden ? t('panels.propertyHidden') : undefined
  const invalid = !name || exists || hidden
  return (
    <form
      className="property-add-form"
      onSubmit={(event) => {
        event.preventDefault()
        if (!invalid) vault.addProperty()
      }}
    >
      <h3 className="panel-subheading">{t('panels.addProperty')}</h3>
      <Input
        label={t('panels.relationName')}
        data-testid="property-name"
        value={vault.propertyName}
        error={error}
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
        <Checkbox
          className="property-check"
          data-testid="property-value"
          label={t('panels.relationValue')}
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
      <div className="property-add-actions">
        <Button className="property-add" size="sm" tone="quiet" type="submit" data-testid="add-property" disabled={invalid}>
          {t('panels.addField')}
        </Button>
        <Button size="sm" tone="quiet" data-testid="add-property-cancel" onClick={() => setOpen(false)}>
          {t('common.cancel')}
        </Button>
      </div>
    </form>
  )
})

export const PropertiesPanel = observer(function PropertiesPanel() {
  const { t } = useTranslation()
  const vault = useService(VaultService)
  const tabs = useService(TabsService)
  const note = vault.active
  const [deleteOpen, setDeleteOpen] = useState(false)
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
  const fields = Object.keys(note.properties).filter((field) => (
    !isHiddenProperty(field) && !isManagedRelation(field, note.properties[field])
  ))
  const titleById = new Map(vault.notes.map((item) => [item.id, item.title]))
  const groupLabels: { key: RelationGroup; label: string }[] = [
    { key: 'belongs_to', label: t('panels.belongsTo') },
    { key: 'related_to', label: t('panels.relatedTo') },
    { key: 'body', label: t('panels.bodyLinks') },
  ]
  const groupOf = (field: string): RelationGroup => structuralRelation(field) ?? 'body'
  return (
    <div className="properties-panel">
      <div className="properties-panel-head">
        <h2 className="panel-heading">{t('panels.properties')}</h2>
        <div className="properties-actions">
          <Button
            size="sm"
            tone="quiet"
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
      <PropertyFields fields={fields} />
      <AddPropertyForm />
      <h2 className="panel-heading">{t('panels.relationships')}</h2>
      <RelationEditor key={note.id} noteId={note.id} />
      {relations.shown.length === 0 && unresolved.length === 0 && (
        <EmptyState compact title={t('panels.noRelations')} testId="relationships-empty" />
      )}
      {groupLabels.map((group) => {
        const shown = relations.shown.filter((link) => (
          link.derived ? group.key === 'body' : groupOf(link.field) === group.key
        ))
        const missing = unresolved.filter((link) => groupOf(link.field) === group.key)
        if (shown.length === 0 && missing.length === 0) return null
        return (
          <section className="relation-group" data-testid={`relation-group-${group.key}`} key={group.key}>
            <h3 className="relation-group-label">{group.label}</h3>
            {shown.map((link) => (
              <RelationLine
                key={`${link.field}-${link.targetId}-${link.derived}`}
                label={titleById.get(link.targetId) || link.label}
                field={link.field}
                names={[link.label, link.targetId].filter(Boolean)}
                targetId={link.targetId || undefined}
                removable={!link.derived && structuralRelation(link.field) !== null}
                onOpen={link.targetId ? () => tabs.openNote(link.targetId) : undefined}
              />
            ))}
            {missing.map((link) => (
              <RelationLine
                key={link.key}
                label={link.label}
                field={link.field}
                names={[link.label]}
                removable={structuralRelation(link.field) !== null}
                onCreate={() => void vault.createLinkedNote(link.label)}
              />
            ))}
          </section>
        )
      })}
      <h2 className="panel-heading">{t('panels.backlinks')}</h2>
      {relations.backlinks.length === 0 && <EmptyState compact title={t('panels.noBacklinks')} testId="backlinks-empty" />}
      {groupLabels.map((group) => {
        const links = relations.backlinks.filter((link) => groupOf(link.via) === group.key)
        if (links.length === 0) return null
        return (
          <section className="relation-group" key={`backlinks-${group.key}`}>
            <h3 className="relation-group-label">{group.label}</h3>
            {links.map((link) => (
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
                {titleById.get(link.sourceId) || graph.byId.get(link.sourceId)?.title}
              </button>
            ))}
          </section>
        )
      })}
    </div>
  )
})
