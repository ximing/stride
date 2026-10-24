import { FileText, GripVertical, MoreHorizontal, Plus, SlidersHorizontal, X } from 'lucide-react'
import { observer, useService } from '@rabjs/react'
import { useTranslation } from 'react-i18next'
import { resolveTypeColor, typeColorKey, typeSidebarLabel } from '@stride/core'
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
  type PropertyKind,
  type StrideNote,
} from '@stride/core/note'
import { useState } from 'react'
import { TabsService } from '../../services/notes/tabs.service'
import { VaultService } from '../../services/vault/vault.service'
import { EmptyState } from '../primitives/empty-state'
import { Button, IconButton } from '../primitives/button'
import { Checkbox } from '../primitives/checkbox'
import { Combobox, type ComboboxOption } from '../primitives/combobox'
import { DatePicker } from '../primitives/date-picker'
import { Mark } from '../primitives/icon'
import { Input } from '../primitives/input'
import { Menu, MenuContent, MenuItem, MenuTrigger } from '../primitives/menu'
import { Select } from '../primitives/select'
import {
  DATE_VALUE,
  STATUS_TONE_DOT,
  collectStatusValues,
  collectTags,
  fieldKindOf,
  statusTone,
} from './field-kind'
import { ListEditor } from './list-editor'

/** Vault-wide candidates for the typed field controls, aggregated once per
 * notes change in the panel and passed down as plain props. */
interface FieldCatalogs {
  tags: ComboboxOption[]
  links: ComboboxOption[]
  statuses: ComboboxOption[]
}

const KIND_LABEL_KEYS = {
  string: 'panels.kindString',
  number: 'panels.kindNumber',
  boolean: 'panels.kindBoolean',
  list: 'panels.kindList',
} as const

const PROPERTY_KINDS = Object.keys(KIND_LABEL_KEYS) as PropertyKind[]

/** The add form offers date on top of the storage kinds; it stores a
 * YYYY-MM-DD string and the row renders the calendar control. */
const ADD_PROPERTY_KINDS: (PropertyKind | 'date')[] = [...PROPERTY_KINDS, 'date']

type RelationGroup = 'belongs_to' | 'related_to' | 'body'

function RelationEditor({ noteId }: { noteId: string }) {
  const { t } = useTranslation()
  const vault = useService(VaultService)
  const [open, setOpen] = useState(false)
  const [kind, setKind] = useState<StructuralRelation>('belongs_to')
  // Every vault note is a candidate from the start; the combobox's search
  // input filters them down.
  const targetOptions: ComboboxOption[] = vault.notes
    .filter((item) => item.id !== noteId && !isArchived(item))
    .map((item) => ({ value: item.id, label: item.title, testId: 'relation-match' }))
    .sort((a, b) => (a.label ?? '').localeCompare(b.label ?? ''))
  const add = (targetId: string) => {
    vault.linkRelation(kind, targetId)
    setOpen(false)
  }
  if (!open) {
    return (
      <Button
        className="property-add-open"
        size="sm"
        tone="quiet"
        icon={<Mark icon={Plus} size={14} />}
        data-testid="add-relation-open"
        onClick={() => setOpen(true)}
      >
        {t('panels.addRelation')}
      </Button>
    )
  }
  return (
    <div
      className="relation-add-form"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation()
          setOpen(false)
        }
      }}
    >
      <div className="relation-add-row">
        <Select
          aria-label={t('panels.relationKind')}
          className="relation-kind-select"
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
        <Combobox
          value=""
          options={targetOptions}
          placeholder={t('panels.relationSearch')}
          searchPlaceholder={t('panels.relationSearch')}
          emptyLabel={t('panels.noMatches')}
          aria-label={t('panels.relationNote')}
          data-testid="relation-target"
          onValueChange={add}
        />
      </div>
    </div>
  )
}

function RelationLine({
  label,
  field,
  names,
  targetId,
  tag,
  removable,
  onOpen,
  onCreate,
}: {
  label: string
  field: string
  names: string[]
  targetId?: string
  /** Kind prefix for structural relations; body links stay untagged. */
  tag?: string
  removable: boolean
  onOpen?: () => void
  onCreate?: () => void
}) {
  const { t } = useTranslation()
  const vault = useService(VaultService)
  const tagNode = tag ? <span className="relation-kind">{tag}</span> : null
  const iconNode = <Mark icon={FileText} size={14} />
  return (
    <div className="relation-line">
      {targetId ? (
        <button
          type="button"
          className="relation-row"
          data-testid="relation-link"
          data-target={targetId}
          onClick={onOpen}
        >
          {iconNode}
          {tagNode}
          <span className="relation-title">{label}</span>
        </button>
      ) : (
        <p className="relation-row is-missing">
          {iconNode}
          {tagNode}
          <span className="relation-title">{label}</span>
        </p>
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

/** Single-select status combobox: presets + vault values, tinted by tone. */
function StatusField({ field, value, options }: { field: string; value: string; options: ComboboxOption[] }) {
  const { t } = useTranslation()
  const vault = useService(VaultService)
  return (
    <Combobox
      value={value}
      options={options}
      allowCreate
      createLabel={(next) => t('panels.createValue', { value: next })}
      emptyLabel={t('panels.noMatches')}
      searchPlaceholder={t('panels.statusSearch')}
      placeholder={t('panels.selectStatus')}
      triggerClassName={`is-${statusTone(value)}`}
      aria-label={field}
      data-testid="status-combobox"
      onValueChange={(next) => vault.updateProperty(field, next)}
    />
  )
}

/** Date field: a custom calendar popover (storage stays a YYYY-MM-DD string)
 * with Today / Clear shortcuts in the footer. */
function DateField({ field, value }: { field: string; value: string }) {
  const { t } = useTranslation()
  const vault = useService(VaultService)
  return (
    <DatePicker
      value={value}
      ariaLabel={field}
      placeholder={t('panels.pickDate')}
      prevMonthLabel={t('panels.prevMonth')}
      nextMonthLabel={t('panels.nextMonth')}
      todayLabel={t('panels.today')}
      clearLabel={t('panels.clearDate')}
      data-testid="date-input"
      onChange={(next) => vault.updateProperty(field, next)}
    />
  )
}

const PropertyRow = observer(function PropertyRow({ field, catalogs }: { field: string; catalogs: FieldCatalogs }) {
  const { t } = useTranslation()
  const vault = useService(VaultService)
  const note = vault.active
  if (!note) return null
  const value = note.properties[field]
  const kind = fieldKindOf(field, value)
  return (
    <div className="property-body">
      <div className="property-head">
        <PropertyName field={field} />
      </div>
      <div className="property-value">
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
        ) : kind === 'tags' ? (
          <ListEditor
            items={Array.isArray(value) ? value : []}
            placeholder={t('panels.addTag')}
            options={catalogs.tags}
            onAdd={(item) => vault.addListItem(field, item)}
            onRemoveAt={(index) => vault.removeListItemAt(field, index)}
          />
        ) : kind === 'links' ? (
          <ListEditor
            items={Array.isArray(value) ? value : []}
            placeholder={t('panels.linkNote')}
            options={catalogs.links}
            onAdd={(item) => vault.addListItem(field, item.startsWith('[[') ? item : `[[${item}]]`)}
            onRemoveAt={(index) => vault.removeListItemAt(field, index)}
          />
        ) : kind === 'list' ? (
          <ListEditor
            items={Array.isArray(value) ? value : []}
            placeholder={t('panels.listAdd')}
            onAdd={(item) => vault.addListItem(field, item)}
            onRemoveAt={(index) => vault.removeListItemAt(field, index)}
          />
        ) : kind === 'status' ? (
          <StatusField field={field} value={typeof value === 'string' ? value : ''} options={catalogs.statuses} />
        ) : kind === 'date' ? (
          <DateField field={field} value={typeof value === 'string' ? value : ''} />
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
    </div>
  )
})

/** Property rows with HTML5 drag reorder: grab the grip, drop above or below a
 * sibling row (drop below the last row moves the field to the end). */
const PropertyFields = observer(function PropertyFields({ fields, catalogs }: { fields: string[]; catalogs: FieldCatalogs }) {
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
            <PropertyRow field={field} catalogs={catalogs} />
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
  const propertyTypeOptions = ADD_PROPERTY_KINDS.map((kind) => ({
    value: kind,
    label: kind === 'date' ? t('panels.kindDate') : t(KIND_LABEL_KEYS[kind]),
  }))
  if (!open) {
    return (
      <Button
        className="property-add-open"
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
  const dateInvalid = vault.propertyType === 'date' && !DATE_VALUE.test(vault.propertyValue.trim())
  const invalid = !name || exists || hidden || dateInvalid
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
      ) : vault.propertyType === 'date' ? (
        <div className="sd-field">
          <span className="sd-field-label">{t('panels.relationValue')}</span>
          <DatePicker
            value={vault.propertyValue}
            ariaLabel={t('panels.relationValue')}
            placeholder={t('panels.pickDate')}
            prevMonthLabel={t('panels.prevMonth')}
            nextMonthLabel={t('panels.nextMonth')}
            todayLabel={t('panels.today')}
            clearLabel={t('panels.clearDate')}
            data-testid="property-value"
            onChange={(next) => vault.setPropertyValue(next)}
          />
        </div>
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
  // Flat row lists, structural relations first; body links carry no tag so
  // the quiet majority stays quiet. A target linked both from a property and
  // from the body shows once — the first (most structural) mention wins.
  type ShownLink = (typeof relations.shown)[number]
  type MissingLink = (typeof unresolved)[number]
  const outgoingRows: { key: string; tag?: string; shown?: ShownLink; missing?: MissingLink }[] =
    groupLabels.flatMap((group) => {
      const tag = group.key === 'body' ? undefined : group.label
      const shown = relations.shown
        .filter((link) => (link.derived ? group.key === 'body' : groupOf(link.field) === group.key))
        .map((link) => ({ key: `${link.field}-${link.targetId}-${link.derived}`, tag, shown: link }))
      const missing = unresolved
        .filter((link) => groupOf(link.field) === group.key)
        .map((link) => ({ key: link.key, tag, missing: link }))
      return [...shown, ...missing]
    })
  const seenOutgoing = new Set<string>()
  const outgoingDeduped = outgoingRows.filter((row) => {
    const target = row.shown ? row.shown.targetId || row.shown.label : row.missing!.label
    if (seenOutgoing.has(target)) return false
    seenOutgoing.add(target)
    return true
  })
  const seenBacklink = new Set<string>()
  const backlinkRows = groupLabels
    .flatMap((group) => {
      const tag = group.key === 'body' ? undefined : group.label
      return relations.backlinks
        .filter((link) => groupOf(link.via) === group.key)
        .map((link) => ({ tag, link }))
    })
    .filter(({ link }) => {
      if (seenBacklink.has(link.sourceId)) return false
      seenBacklink.add(link.sourceId)
      return true
    })

  // Typed-field candidates, aggregated from the vault.
  const typeDocByTitle = new Map(vault.typeDocuments.map((doc) => [doc.title, doc]))
  const typeNames = new Set<string>()
  for (const name of vault.graph.byType.keys()) {
    if (name.trim() !== '') typeNames.add(name)
  }
  for (const doc of vault.typeDocuments) typeNames.add(doc.title)
  if (note.type.trim() !== '') typeNames.add(note.type)
  const typeOptions: ComboboxOption[] = [...typeNames].sort((a, b) => a.localeCompare(b)).map((name) => {
    const doc = typeDocByTitle.get(name)
    const color = doc ? typeColorKey(doc) : resolveTypeColor(name)
    return { value: name, label: doc ? typeSidebarLabel(doc) : name, dot: `var(--sd-dot-${color})` }
  })
  const statusOptions: ComboboxOption[] = [
    { value: 'draft', label: t('panels.statusDraft'), dot: STATUS_TONE_DOT.draft },
    { value: 'doing', label: t('panels.statusDoing'), dot: STATUS_TONE_DOT.doing },
    { value: 'done', label: t('panels.statusDone'), dot: STATUS_TONE_DOT.done },
  ]
  const seenStatuses = new Set(statusOptions.map((option) => option.value.toLowerCase()))
  for (const status of collectStatusValues(vault.notes)) {
    if (seenStatuses.has(status.toLowerCase())) continue
    seenStatuses.add(status.toLowerCase())
    statusOptions.push({ value: status, dot: STATUS_TONE_DOT[statusTone(status)] })
  }
  const catalogs: FieldCatalogs = {
    tags: collectTags(vault.notes).map((tag) => ({ value: tag })),
    links: vault.notes
      .filter((item) => item.id !== note.id && !isArchived(item))
      .map((item) => ({ value: `[[${item.title}]]`, label: item.title }))
      .sort((a, b) => a.label.localeCompare(b.label)),
    statuses: statusOptions,
  }
  return (
    <div className="properties-panel">
      <Combobox
        label={t('panels.type')}
        data-testid="type-combobox"
        value={note.type}
        options={typeOptions}
        allowCreate
        createLabel={(next) => t('panels.createValue', { value: next })}
        emptyLabel={t('panels.noMatches')}
        searchPlaceholder={t('panels.typeSearch')}
        placeholder={t('panels.type')}
        onValueChange={(next) => vault.updateType(next)}
      />
      <PropertyFields fields={fields} catalogs={catalogs} />
      <AddPropertyForm />
      <h2 className="properties-section-label">{t('panels.relationships')}</h2>
      <RelationEditor key={note.id} noteId={note.id} />
      {relations.shown.length === 0 && unresolved.length === 0 && (
        <EmptyState compact title={t('panels.noRelations')} testId="relationships-empty" />
      )}
      {outgoingDeduped.map((row) =>
        row.shown ? (
          <RelationLine
            key={row.key}
            tag={row.tag}
            label={titleById.get(row.shown.targetId) || row.shown.label}
            field={row.shown.field}
            names={[row.shown.label, row.shown.targetId].filter(Boolean)}
            targetId={row.shown.targetId || undefined}
            removable={!row.shown.derived && structuralRelation(row.shown.field) !== null}
            onOpen={row.shown.targetId ? () => tabs.openNote(row.shown!.targetId) : undefined}
          />
        ) : (
          <RelationLine
            key={row.key}
            tag={row.tag}
            label={row.missing!.label}
            field={row.missing!.field}
            names={[row.missing!.label]}
            removable={structuralRelation(row.missing!.field) !== null}
            onCreate={() => void vault.createLinkedNote(row.missing!.label)}
          />
        ),
      )}
      <h2 className="properties-section-label">{t('panels.backlinks')}</h2>
      {relations.backlinks.length === 0 && <EmptyState compact title={t('panels.noBacklinks')} testId="backlinks-empty" />}
      {backlinkRows.map(({ tag, link }) => (
        <button
          key={`${link.sourceId}-${link.via}`}
          type="button"
          className="relation-row"
          data-testid="backlink"
          data-source={link.sourceId}
          onClick={() => {
            if (link.sourceId) tabs.openNote(link.sourceId)
          }}
        >
          <Mark icon={FileText} size={14} />
          {tag ? <span className="relation-kind">{tag}</span> : null}
          <span className="relation-title">{titleById.get(link.sourceId) || graph.byId.get(link.sourceId)?.title}</span>
        </button>
      ))}
    </div>
  )
})
