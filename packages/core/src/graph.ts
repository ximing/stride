import {
  bodyWikilinks,
  wikilinkTargets,
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

export function normalizeField(field: string): string {
  return field.trim().toLowerCase().replace(/\s+/g, ' ')
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

export function resolveNote(notes: StrideNote[], ref: string): StrideNote | undefined {
  const key = ref.trim().toLowerCase()
  if (!key) return undefined
  return (
    notes.find((note) => note.title.toLowerCase() === key) ??
    notes.find((note) => note.id.toLowerCase() === key) ??
    notes.find((note) => note.id.toLowerCase() === key.replace(/\s+/g, '-'))
  )
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
    for (const target of bodyWikilinks(note.doc)) {
      const resolved = resolveNote(notes, target)
      if (!resolved || resolved.id === note.id) continue
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
