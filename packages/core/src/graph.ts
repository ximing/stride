import {
  bodyWikilinks,
  wikilinkTargets,
  type NoteProperty,
  type StrideNote,
} from './note.ts'

export interface RelationshipLink {
  field: string
  targetId: string
  label: string
  derived: boolean
}

export interface Backlink {
  sourceId: string
  via: string
}

export interface NoteRelations {
  outgoing: { field: string; target: string; resolvedId?: string }[]
  shown: RelationshipLink[]
  backlinks: Backlink[]
}

export interface VaultGraph {
  notes: StrideNote[]
  byId: Map<string, StrideNote>
  relations: Map<string, NoteRelations>
  inbox: StrideNote[]
  byType: Map<string, StrideNote[]>
}

const BELONGS = new Set(['belongs_to', 'belongs to'])
const RELATED = new Set(['related_to', 'related to'])
const WIKILINK_TOKEN = /\[\[[^\]]+\]\]/g

export type StructuralRelation = 'belongs_to' | 'related_to'

export function normalizeField(field: string): string {
  return field.trim().toLowerCase().replace(/\s+/g, ' ')
}

export function structuralRelation(field: string): StructuralRelation | null {
  const canonical = normalizeField(field)
  if (BELONGS.has(canonical)) return 'belongs_to'
  if (RELATED.has(canonical)) return 'related_to'
  return null
}

/** Keep an existing `belongs to` / `related to` key; otherwise use the canonical name. */
export function relationStorageKey(
  properties: Record<string, NoteProperty>,
  kind: StructuralRelation,
): string {
  return Object.keys(properties).find((field) => structuralRelation(field) === kind) ?? kind
}

function sameTitle(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase()
}

function withoutTokens(raw: string, names: readonly string[]): string {
  return raw
    .replace(WIKILINK_TOKEN, (token) => {
      const inner = token.slice(2, -2).trim()
      return names.some((name) => sameTitle(inner, name)) ? '' : token
    })
    .replace(/[\s,]+/g, ' ')
    .trim()
}

function linkOnly(value: NoteProperty): boolean {
  if (typeof value === 'string') {
    return wikilinkTargets(value).length > 0 && value.replace(WIKILINK_TOKEN, '').replace(/[\s,]+/g, '') === ''
  }
  if (!Array.isArray(value) || value.length === 0) return false
  return value.every((item) => (
    typeof item === 'string'
    && wikilinkTargets(item).length > 0
    && item.replace(WIKILINK_TOKEN, '').replace(/[\s,]+/g, '') === ''
  ))
}

/** True when this property is only `belongs_to` / `related_to` wikilinks, so the relationship editor owns it. */
export function isManagedRelation(field: string, value: NoteProperty | undefined): boolean {
  return value !== undefined && structuralRelation(field) !== null && linkOnly(value)
}

export function addRelationTarget(value: NoteProperty | undefined, title: string): NoteProperty {
  const name = title.trim()
  const token = `[[${name}]]`
  if (!name) return value ?? ''
  if (wikilinkTargets(value).some((item) => sameTitle(item, name))) return value ?? [token]
  if (value === undefined || value === '') return [token]
  if (Array.isArray(value)) return [...value, token]
  if (typeof value === 'string') {
    if (linkOnly(value)) return [...wikilinkTargets(value).map((item) => `[[${item}]]`), token]
    return `${value} ${token}`.trim()
  }
  return [token]
}

/** Drop wikilinks whose text matches any name. `undefined` means the property should be removed. */
export function removeRelationTarget(
  value: NoteProperty | undefined,
  names: readonly string[],
): NoteProperty | undefined {
  const wanted = names.map((name) => name.trim()).filter(Boolean)
  if (wanted.length === 0) return value
  if (Array.isArray(value)) {
    const next = value.flatMap((item) => {
      if (typeof item !== 'string') return []
      if (wikilinkTargets(item).length === 0) return wanted.some((name) => sameTitle(item, name)) ? [] : [item]
      const kept = withoutTokens(item, wanted)
      return kept ? [kept] : []
    })
    return next.length > 0 ? next : undefined
  }
  if (typeof value === 'string') {
    if (wikilinkTargets(value).length === 0) return wanted.some((name) => sameTitle(value, name)) ? undefined : value
    const next = withoutTokens(value, wanted)
    return next ? next : undefined
  }
  return value
}

export function relationshipFields(note: StrideNote): { field: string; targets: string[] }[] {
  const fields: { field: string; targets: string[] }[] = []
  for (const [field, value] of Object.entries(note.properties)) {
    const targets = wikilinkTargets(value)
    if (targets.length > 0) fields.push({ field, targets })
  }
  return fields
}

export function hasOutgoingRelationship(note: StrideNote): boolean {
  return relationshipFields(note).length > 0
}

/** Title, exact id, or id after the link's whitespace is folded to `-`. Title wins on the same note. */
export function matchNoteLink(
  ref: string,
  note: { title: string; id: string },
): 'title' | 'id' | 'folded-id' | null {
  const key = ref.trim().toLowerCase()
  if (!key) return null
  if (note.title.toLowerCase() === key) return 'title'
  if (note.id === '') return null
  const id = note.id.toLowerCase()
  if (id === key) return 'id'
  if (id === key.replace(/\s+/g, '-')) return 'folded-id'
  return null
}

export function resolveNote(notes: StrideNote[], ref: string): StrideNote | undefined {
  let idHit: StrideNote | undefined
  let foldedHit: StrideNote | undefined
  for (const note of notes) {
    const hit = matchNoteLink(ref, note)
    if (hit === 'title') return note
    if (hit === 'id') idHit ??= note
    else if (hit === 'folded-id') foldedHit ??= note
  }
  return idHit ?? foldedHit
}

export function groupByType(notes: StrideNote[]): Map<string, StrideNote[]> {
  const groups = new Map<string, StrideNote[]>()
  for (const note of notes) {
    const type = note.type.trim() || 'note'
    const list = groups.get(type)
    if (list) list.push(note)
    else groups.set(type, [note])
  }
  return groups
}

export function buildGraph(notes: StrideNote[]): VaultGraph {
  const byId = new Map(notes.map((note) => [note.id, note]))
  const relations = new Map<string, NoteRelations>()
  for (const note of notes) {
    relations.set(note.id, { outgoing: [], shown: [], backlinks: [] })
  }

  const addShown = (id: string, link: RelationshipLink) => {
    const bag = relations.get(id)
    if (!bag) return
    const exists = bag.shown.some((item) => item.field === link.field && item.targetId === link.targetId && item.derived === link.derived)
    if (!exists) bag.shown.push(link)
  }

  for (const note of notes) {
    const bag = relations.get(note.id)
    if (!bag) continue
    for (const field of relationshipFields(note)) {
      const canonical = normalizeField(field.field)
      for (const target of field.targets) {
        const resolved = resolveNote(notes, target)
        bag.outgoing.push({ field: field.field, target, resolvedId: resolved?.id })
        if (!resolved) continue
        addShown(note.id, {
          field: field.field,
          targetId: resolved.id,
          label: resolved.title,
          derived: false,
        })
        if (BELONGS.has(canonical)) {
          addShown(resolved.id, {
            field: 'has',
            targetId: note.id,
            label: note.title,
            derived: true,
          })
        } else if (RELATED.has(canonical)) {
          addShown(resolved.id, {
            field: 'related_to',
            targetId: note.id,
            label: note.title,
            derived: true,
          })
        } else {
          addShown(resolved.id, {
            field: field.field,
            targetId: note.id,
            label: note.title,
            derived: true,
          })
        }
        relations.get(resolved.id)?.backlinks.push({ sourceId: note.id, via: field.field })
      }
    }
    // Body wikilinks are outgoing in the inspector. They do not count toward inbox.
    for (const target of bodyWikilinks(note.doc)) {
      const resolved = resolveNote(notes, target)
      if (!resolved || resolved.id === note.id) continue
      addShown(note.id, {
        field: 'body',
        targetId: resolved.id,
        label: resolved.title,
        derived: false,
      })
      const backlinks = relations.get(resolved.id)?.backlinks
      if (!backlinks) continue
      if (!backlinks.some((link) => link.sourceId === note.id && link.via === 'body')) {
        backlinks.push({ sourceId: note.id, via: 'body' })
      }
    }
  }

  return {
    notes,
    byId,
    relations,
    inbox: notes.filter((note) => !hasOutgoingRelationship(note)),
    byType: groupByType(notes),
  }
}

export function relationsOf(graph: VaultGraph, id: string): NoteRelations {
  return graph.relations.get(id) ?? { outgoing: [], shown: [], backlinks: [] }
}
