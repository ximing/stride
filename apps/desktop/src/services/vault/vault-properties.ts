import {
  addRelationTarget,
  hasOutgoingRelationship,
  relationStorageKey,
  removeRelationTarget,
  structuralRelation,
  type StructuralRelation,
} from '@stride/core/graph'
import {
  formatProperty,
  parseFiniteNumber,
  parseListInput,
  parsePropertyInput,
  type NoteProperty,
  type StrideNote,
} from '@stride/core/note'
import type { VaultService } from './vault.service'

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isTypeDocument(note: StrideNote): boolean {
  return note.type === 'Type'
}

export function setPropertyName(vault: VaultService, value: string) {
  vault.propertyName = value
}

export function setPropertyType(vault: VaultService, value: string) {
  if (value === 'string' || value === 'number' || value === 'boolean' || value === 'list') {
    vault.propertyType = value
  }
}

export function setPropertyValue(vault: VaultService, value: string) {
  vault.propertyValue = value
}

export function setPropertyChecked(vault: VaultService, value: boolean) {
  vault.propertyChecked = value
}

export function linkRelation(vault: VaultService, kind: StructuralRelation, targetId: string) {
  const current = vault.active
  if (!current || current.id === targetId) return
  const target = vault.notes.find((note) => note.id === targetId)
  const title = target?.title.trim() ?? ''
  if (!title) return
  const field = relationStorageKey(current.properties, kind)
  clearFieldDraft(vault, field)
  writeProperty(vault, field, addRelationTarget(current.properties[field], title))
}

export function unlinkRelation(vault: VaultService, field: string, names: readonly string[]) {
  const current = vault.active
  if (!current || !structuralRelation(field) || !Object.hasOwn(current.properties, field)) return
  const next = removeRelationTarget(current.properties[field], names)
  clearFieldDraft(vault, field)
  if (next === undefined) removeProperty(vault, field)
  else writeProperty(vault, field, next)
}

export function addProperty(vault: VaultService) {
  const field = vault.propertyName.trim()
  if (!field || !vault.active) return
  let next: NoteProperty | undefined
  if (vault.propertyType === 'boolean') next = vault.propertyChecked
  else if (vault.propertyType === 'number') next = parseFiniteNumber(vault.propertyValue)
  else if (vault.propertyType === 'list') {
    const items = parseListInput(vault.propertyValue)
    if (items.length > 0) next = items
  } else {
    const parsed = parsePropertyInput(vault.propertyValue)
    if (parsed !== '' && !(Array.isArray(parsed) && parsed.length === 0)) next = parsed
  }
  if (next === undefined) return
  clearFieldDraft(vault, field)
  writeProperty(vault, field, next)
  vault.propertyName = ''
  vault.propertyValue = ''
  vault.propertyChecked = false
}

export function updateProperty(vault: VaultService, field: string, raw: string) {
  const current = vault.active
  if (!current) return
  const value: NoteProperty = parsePropertyInput(raw)
  const properties = { ...current.properties }
  if (value === '' || (Array.isArray(value) && value.length === 0)) delete properties[field]
  else properties[field] = value
  clearFieldDraft(vault, field)
  vault.replace({ ...current, properties })
  vault.schedule(current.id)
  maybeAdvanceInbox(vault, current)
}

export function updateListProperty(vault: VaultService, field: string, raw: string) {
  const items = parseListInput(raw)
  if (items.length === 0) {
    removeProperty(vault, field)
    return
  }
  vault.listDrafts = { ...vault.listDrafts, [field]: raw }
  writeProperty(vault, field, items)
}

export function updateNumberProperty(vault: VaultService, field: string, raw: string) {
  if (raw.trim() === '') {
    removeProperty(vault, field)
    return
  }
  vault.numberDrafts = { ...vault.numberDrafts, [field]: raw }
  const parsed = parseFiniteNumber(raw)
  if (parsed === undefined) return
  writeProperty(vault, field, parsed)
}

export function updateBooleanProperty(vault: VaultService, field: string, value: boolean) {
  writeProperty(vault, field, value)
}

export function removeProperty(vault: VaultService, field: string) {
  const current = vault.active
  clearFieldDraft(vault, field)
  if (!current || !Object.hasOwn(current.properties, field)) return
  const properties = { ...current.properties }
  delete properties[field]
  vault.replace({ ...current, properties })
  vault.schedule(current.id)
}

export function commitListProperty(vault: VaultService, field: string) {
  const raw = vault.listDrafts[field]
  if (raw !== undefined) {
    clearFieldDraft(vault, field)
    const items = parseListInput(raw)
    if (items.length === 0) removeProperty(vault, field)
    else writeProperty(vault, field, items)
  }
  blurProperty(vault)
}

export function commitNumberProperty(vault: VaultService, field: string) {
  const raw = vault.numberDrafts[field]
  if (raw !== undefined) {
    clearFieldDraft(vault, field)
    if (raw.trim() === '') removeProperty(vault, field)
    else {
      const parsed = parseFiniteNumber(raw)
      if (parsed !== undefined) writeProperty(vault, field, parsed)
    }
  }
  blurProperty(vault)
}

export function blurProperty(vault: VaultService) {
  void vault.flush().catch((error: unknown) => {
    vault.error = errorText(error)
  })
}

export function numberText(vault: VaultService, field: string): string {
  if (Object.hasOwn(vault.numberDrafts, field)) return vault.numberDrafts[field] ?? ''
  const value = vault.active?.properties[field]
  return typeof value === 'number' ? String(value) : ''
}

export function listText(vault: VaultService, field: string): string {
  if (Object.hasOwn(vault.listDrafts, field)) return vault.listDrafts[field] ?? ''
  return formatProperty(vault.active?.properties[field])
}

export function propertyText(vault: VaultService, field: string): string {
  return formatProperty(vault.active?.properties[field])
}

export function writeProperty(vault: VaultService, field: string, value: NoteProperty) {
  const current = vault.active
  if (!current) return
  vault.replace({ ...current, properties: { ...current.properties, [field]: value } })
  vault.schedule(current.id)
  maybeAdvanceInbox(vault, current)
}

export function maybeAdvanceInbox(vault: VaultService, before: StrideNote) {
  if (vault.listFilter !== 'inbox' || !vault.advanceInbox) return
  if (vault.activeId !== before.id || hasOutgoingRelationship(before)) return
  const after = vault.notes.find((note) => note.id === before.id)
  if (!after || !hasOutgoingRelationship(after)) return
  const index = vault.notes.findIndex((note) => note.id === before.id)
  const next = vault.notes.slice(index + 1).find((note) => !isTypeDocument(note) && !hasOutgoingRelationship(note))
  vault.activeId = next?.id ?? ''
  resetPropertyEditor(vault)
}

export function clearFieldDraft(vault: VaultService, field: string) {
  if (Object.hasOwn(vault.numberDrafts, field)) {
    const numberDrafts = { ...vault.numberDrafts }
    delete numberDrafts[field]
    vault.numberDrafts = numberDrafts
  }
  if (Object.hasOwn(vault.listDrafts, field)) {
    const listDrafts = { ...vault.listDrafts }
    delete listDrafts[field]
    vault.listDrafts = listDrafts
  }
}

export function resetPropertyEditor(vault: VaultService) {
  vault.propertyName = ''
  vault.propertyType = 'string'
  vault.propertyValue = ''
  vault.propertyChecked = false
  vault.numberDrafts = {}
  vault.listDrafts = {}
}
