import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'
import {
  addRelationTarget,
  buildGraph,
  relationStorageKey,
  relationsOf,
  removeRelationTarget,
  resolveNote,
  structuralRelation,
  type StructuralRelation,
} from './graph.ts'
import {
  applyTitle,
  bodyWikilinks,
  DATE_VALUE,
  isArchived,
  noteForSave,
  parseFiniteNumber,
  parseListInput,
  plainText,
  serializeNote,
  type NoteProperty,
  type StrideNote,
  type TipTapNode,
} from './note.ts'
import {
  compareTypeDocuments,
  isTypeVisible,
  nextTypeOrder,
  templateBody,
  TYPE_COLOR_KEYS,
  typeSortOrder,
} from './types.ts'
import { type LoadedView, type SavedView, type ViewSort, VIEW_FILE_VERSION } from './views.ts'

export const WRITE_VAULT_TOOLS = [
  'write_note',
  'append_to_note',
  'insert_block',
  'remove_block',
  'create_note',
  'set_note',
  'undo_note',
  'set_property',
  'rename_property',
  'remove_property',
  'link_relation',
  'unlink_relation',
  'create_type',
  'update_type',
  'save_view',
  'delete_view',
] as const

export const VAULT_ASSISTANT_PROMPT = [
  'You are Stride, a local vault assistant. Use the vault tools before answering.',
  'Safe mode can read. Power mode can also change the vault. Do not delete notes, rename note files, or run shell or git commands.',
  'Notes stay TipTap JSON. Edit content by node. Never replace a document with a plain-text paragraph.',
  'Notes: list_notes, search_vault, read_note, read_active_note, create_note, set_note. set_note changes title, type, or archived. The note id stays the same.',
  'Content: append_to_note, write_note, insert_block, remove_block, undo_note. undo_note restores the last snapshot of that note.',
  'Properties: set_property, rename_property, remove_property. Kinds are string, number, boolean, list, and date (YYYY-MM-DD).',
  'Relationships: get_relations, get_backlinks, link_relation, unlink_relation. Kinds are belongs_to and related_to. Do not store those keys with set_property.',
  'Types: list_types, create_type, update_type. A type is a note whose type is Type. Renaming a type updates instances and saved views that filter on it.',
  'Views: list_views, save_view, delete_view. A view filters notes by type and properties.',
].join('\n')

export function toolsForAgentMode(tools: AgentTool[], mode: 'safe' | 'power'): AgentTool[] {
  if (mode === 'power') return tools
  const blocked = new Set<string>(WRITE_VAULT_TOOLS)
  return tools.filter((tool) => !blocked.has(tool.name))
}

export interface VaultViewStore {
  list(): Promise<LoadedView[]> | LoadedView[]
  save(input: { file?: string; view: SavedView }): Promise<LoadedView> | LoadedView
  remove(file: string): Promise<void> | void
}

export interface VaultToolHost {
  readNote(id: string): Promise<StrideNote> | StrideNote
  writeSerialized(id: string, serialized: string): Promise<void> | void
  searchVault(query: string): Promise<{ id: string; title: string; snippet: string }[]> | { id: string; title: string; snippet: string }[]
  createNote(title: string): Promise<StrideNote> | StrideNote
  loadNotes(): Promise<StrideNote[]> | StrideNote[]
  activeNoteId?: string
  views?: VaultViewStore
}

function toolText(text: string, details: unknown = null) {
  return { content: [{ type: 'text' as const, text }], details }
}

function notePayload(note: StrideNote) {
  return {
    id: note.id,
    title: note.title,
    type: note.type,
    properties: note.properties,
    plainText: plainText(note.doc),
    doc: note.doc,
  }
}

function asNode(value: unknown): TipTapNode {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('node must be an object')
  const node = value as TipTapNode
  if (typeof node.type !== 'string' || !node.type.trim()) throw new Error('node type is required')
  return node
}

function asPath(value: unknown): number[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('path must be a non-empty list of indexes')
  if (value.some((item) => typeof item !== 'number' || !Number.isInteger(item))) {
    throw new Error('path must be a non-empty list of indexes')
  }
  return value
}

function asText(value: unknown, label: string): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  throw new Error(`${label} must be text`)
}

function firstText(value: NoteProperty | undefined): string {
  const picked = Array.isArray(value) ? value[0] : value
  if (typeof picked === 'string') return picked
  if (typeof picked === 'number' || typeof picked === 'boolean') return String(picked)
  return ''
}

function isTypeDocument(note: StrideNote): boolean {
  return note.type === 'Type'
}

export function applyWrite(node: TipTapNode, path: number[], replacement: TipTapNode): TipTapNode {
  const [head, ...rest] = path
  if (head === undefined || head < 0) throw new Error('path not found')
  const content = [...(node.content ?? [])]
  const current = content[head]
  if (current === undefined) throw new Error('path not found')
  content[head] = rest.length === 0 ? replacement : applyWrite(current, rest, replacement)
  return { ...node, content }
}

export function insertBlock(doc: TipTapNode, index: number, block: TipTapNode): TipTapNode {
  if (!Number.isInteger(index) || index < 0) throw new Error('index out of range')
  const content = [...(doc.content ?? [])]
  if (index > content.length) throw new Error('index out of range')
  content.splice(index, 0, block)
  return { ...doc, content }
}

export function removeBlock(node: TipTapNode, path: number[]): TipTapNode {
  const [head, ...rest] = path
  if (head === undefined || head < 0) throw new Error('path not found')
  const content = [...(node.content ?? [])]
  const current = content[head]
  if (current === undefined) throw new Error('path not found')
  if (rest.length === 0) {
    content.splice(head, 1)
    return { ...node, content }
  }
  content[head] = removeBlock(current, rest)
  return { ...node, content }
}

const nodeSchema = Type.Object({ type: Type.String({ minLength: 1 }) }, { additionalProperties: true })
const PROPERTY_KINDS = ['string', 'number', 'boolean', 'list', 'date'] as const
type PropertyInputKind = (typeof PROPERTY_KINDS)[number]

function propertyValue(kind: PropertyInputKind, raw: string): NoteProperty {
  if (kind === 'boolean') {
    if (raw === 'true') return true
    if (raw === 'false') return false
    throw new Error('boolean value must be true or false')
  }
  if (kind === 'number') {
    const value = parseFiniteNumber(raw)
    if (value === undefined) throw new Error('number value must be a finite number')
    return value
  }
  if (kind === 'date') {
    const text = raw.trim()
    if (!DATE_VALUE.test(text)) throw new Error('date value must be YYYY-MM-DD')
    return text
  }
  if (kind === 'list') {
    const items = parseListInput(raw)
    if (items.length === 0) throw new Error('list value is empty')
    return items
  }
  if (raw === '') throw new Error('string value is empty')
  return raw
}

function editablePropertyKey(note: StrideNote, key: string): string {
  const name = key.trim()
  if (!name) throw new Error('Property name is required')
  if (name.startsWith('_')) throw new Error('System properties are managed by update_type')
  if (structuralRelation(name)) throw new Error('Use link_relation for belongs_to and related_to')
  if (name === 'archived') throw new Error('Use set_note to archive a note')
  if (isTypeDocument(note) && name === 'visible') throw new Error('Use update_type to change type visibility')
  return name
}

function colorOrThrow(color: string): string {
  const value = color.trim()
  if (!(TYPE_COLOR_KEYS as readonly string[]).includes(value)) {
    throw new Error(`color must be one of ${TYPE_COLOR_KEYS.join(', ')}`)
  }
  return value
}

function typeTitleOrThrow(title: string): string {
  const value = title.trim()
  if (!value) throw new Error('Title is required')
  if (value === 'Type') throw new Error('Type is a reserved title')
  return value
}

function viewFromInput(raw: {
  name: string
  icon?: string
  color?: string
  type?: string
  archived?: boolean
  sort?: { key: string; dir: string }
  propertyFilters?: { key: string; op: string; value?: string }[]
}): SavedView {
  const name = raw.name.trim()
  if (!name) throw new Error('View name is required')
  const view: SavedView = { version: VIEW_FILE_VERSION, name }
  const icon = raw.icon?.trim()
  if (icon) view.icon = icon
  if (raw.color?.trim()) view.color = colorOrThrow(raw.color)
  const type = raw.type?.trim()
  if (type) view.type = type
  if (raw.archived === true) view.archived = true
  if (raw.sort) view.sort = viewSort(raw.sort)
  const filters: NonNullable<SavedView['propertyFilters']> = []
  for (const filter of raw.propertyFilters ?? []) {
    const key = filter.key.trim()
    if (!key) throw new Error('Filter key is required')
    if (filter.op === 'exists') {
      filters.push({ key, op: 'exists' })
      continue
    }
    if (filter.op !== 'eq' && filter.op !== 'contains') throw new Error('Filter op must be eq, contains, or exists')
    const value = filter.value?.trim() ?? ''
    if (!value) throw new Error('Filter value is required')
    filters.push({ key, op: filter.op, value })
  }
  if (filters.length > 0) view.propertyFilters = filters
  return view
}

function viewSort(sort: { key: string; dir: string }): ViewSort {
  const key = sort.key
  const dir = sort.dir
  if (key !== 'mtime' && key !== 'title' && key !== 'created') throw new Error('sort key must be mtime, title, or created')
  if (dir !== 'asc' && dir !== 'desc') throw new Error('sort dir must be asc or desc')
  return { key, dir }
}

function typePayload(note: StrideNote) {
  const order = typeSortOrder(note)
  return {
    id: note.id,
    title: note.title,
    icon: firstText(note.properties._icon),
    color: firstText(note.properties._color),
    visible: isTypeVisible(note),
    sidebarLabel: firstText(note.properties._sidebar_label),
    order: Number.isFinite(order) ? order : null,
  }
}

export function vaultTools(host: VaultToolHost): AgentTool[] {
  const snapshots = new Map<string, string>()

  const commit = async (note: StrideNote): Promise<StrideNote> => {
    const saved = noteForSave(note)
    snapshots.set(saved.id, serializeNote(await host.readNote(saved.id)))
    await host.writeSerialized(saved.id, serializeNote(saved))
    return saved
  }

  const requireViews = (): VaultViewStore => {
    if (!host.views) throw new Error('Saved views are not available')
    return host.views
  }

  const readNote: AgentTool = {
    name: 'read_note',
    label: 'Read note',
    description: 'Read a vault note as TipTap JSON plus plain text. Do not treat the plain text as the document.',
    parameters: Type.Object({ id: Type.String({ minLength: 1 }) }),
    execute: async (_toolCallId, params) => {
      const id = (params as { id: string }).id
      const note = await host.readNote(id)
      return toolText(JSON.stringify(notePayload(note)), { id })
    },
  }

  const readActive: AgentTool = {
    name: 'read_active_note',
    label: 'Read active note',
    description: 'Read the note currently open in the vault as TipTap JSON.',
    parameters: Type.Object({}),
    execute: async () => {
      if (!host.activeNoteId) throw new Error('No note is open')
      const note = await host.readNote(host.activeNoteId)
      return toolText(JSON.stringify(notePayload(note)), { id: note.id })
    },
  }

  const search: AgentTool = {
    name: 'search_vault',
    label: 'Search vault',
    description: 'Search vault notes through the vault search index.',
    parameters: Type.Object({ query: Type.String({ minLength: 1 }) }),
    execute: async (_toolCallId, params) => {
      const query = (params as { query: string }).query
      const hits = await host.searchVault(query)
      return toolText(JSON.stringify(hits), { query })
    },
  }

  const list: AgentTool = {
    name: 'list_notes',
    label: 'List notes',
    description: 'List every note id, title, type, and archived flag, including type documents.',
    parameters: Type.Object({}),
    execute: async () => {
      const notes = await host.loadNotes()
      return toolText(JSON.stringify(notes.map((note) => ({
        id: note.id,
        title: note.title,
        type: note.type,
        archived: isArchived(note),
      }))))
    },
  }

  const backlinks: AgentTool = {
    name: 'get_backlinks',
    label: 'Get backlinks',
    description: 'List notes that link to a note.',
    parameters: Type.Object({ id: Type.String({ minLength: 1 }) }),
    execute: async (_toolCallId, params) => {
      const id = (params as { id: string }).id
      const notes = await host.loadNotes()
      if (!notes.some((note) => note.id === id)) throw new Error('Note not found')
      const links = relationsOf(buildGraph(notes), id).backlinks
      return toolText(JSON.stringify(links), { id })
    },
  }

  const relations: AgentTool = {
    name: 'get_relations',
    label: 'Get relations',
    description: 'List a note\'s property links, body wikilinks, and backlinks. Property links use belongs_to and related_to.',
    parameters: Type.Object({ id: Type.String({ minLength: 1 }) }),
    execute: async (_toolCallId, params) => {
      const id = (params as { id: string }).id
      const notes = await host.loadNotes()
      const note = notes.find((item) => item.id === id)
      if (!note) throw new Error('Note not found')
      const bag = relationsOf(buildGraph(notes), id)
      return toolText(JSON.stringify({
        id,
        properties: bag.outgoing,
        body: bodyWikilinks(note.doc),
        backlinks: bag.backlinks,
      }), { id })
    },
  }

  const listTypes: AgentTool = {
    name: 'list_types',
    label: 'List types',
    description: 'List type documents: id, title, icon, color, visibility, sidebar label, and order.',
    parameters: Type.Object({}),
    execute: async () => {
      const notes = (await host.loadNotes()).filter(isTypeDocument).sort(compareTypeDocuments)
      return toolText(JSON.stringify(notes.map(typePayload)))
    },
  }

  const listViews: AgentTool = {
    name: 'list_views',
    label: 'List views',
    description: 'List saved views. Each view has a file slug, name, optional type, property filters, and sort.',
    parameters: Type.Object({}),
    execute: async () => toolText(JSON.stringify(await requireViews().list())),
  }

  const create: AgentTool = {
    name: 'create_note',
    label: 'Create note',
    description: 'Create a note. Optional type applies that type and its template body. The note id is chosen from the title and then stays put.',
    parameters: Type.Object({
      title: Type.String({ minLength: 1 }),
      type: Type.Optional(Type.String()),
    }),
    execute: async (_toolCallId, params) => {
      const record = params as { title: string; type?: string }
      const title = record.title.trim()
      if (!title) throw new Error('Title is required')
      const typeName = record.type?.trim() ?? ''
      if (typeName === 'Type') throw new Error('Use create_type for type documents')
      let note = await host.createNote(title)
      if (typeName) {
        const typeDoc = (await host.loadNotes()).find((item) => isTypeDocument(item) && item.title === typeName)
        const body = templateBody(typeDoc?.properties.template)
        note = await commit({ ...note, type: typeName, doc: body ?? note.doc })
      }
      return toolText(JSON.stringify(notePayload(note)), { id: note.id })
    },
  }

  const setNote: AgentTool = {
    name: 'set_note',
    label: 'Set note fields',
    description: 'Change a note title, type, or archived flag. The note id does not change. Use update_type for type documents.',
    parameters: Type.Object({
      id: Type.String({ minLength: 1 }),
      title: Type.Optional(Type.String()),
      type: Type.Optional(Type.String()),
      archived: Type.Optional(Type.Boolean()),
    }),
    execute: async (_toolCallId, params) => {
      const record = params as { id: string; title?: string; type?: string; archived?: boolean }
      if (record.title === undefined && record.type === undefined && record.archived === undefined) {
        throw new Error('Set a title, type, or archived flag')
      }
      const current = await host.readNote(record.id)
      if (isTypeDocument(current)) throw new Error('Use update_type for type documents')
      let next = current
      if (record.title !== undefined) {
        const title = record.title.trim()
        if (!title) throw new Error('Title is required')
        next = { ...next, title, doc: applyTitle(next.doc, title) }
      }
      if (record.type !== undefined) {
        const type = record.type.trim()
        if (!type) throw new Error('Type is required')
        if (type === 'Type') throw new Error('Use create_type for type documents')
        next = { ...next, type }
      }
      if (record.archived !== undefined) {
        const properties = { ...next.properties }
        if (record.archived) properties.archived = true
        else delete properties.archived
        next = { ...next, properties }
      }
      const saved = await commit(next)
      return toolText(JSON.stringify(notePayload(saved)), { id: saved.id })
    },
  }

  const append: AgentTool = {
    name: 'append_to_note',
    label: 'Append to note',
    description: 'Append one TipTap block. Existing blocks stay untouched.',
    parameters: Type.Object({ id: Type.String({ minLength: 1 }), node: nodeSchema }),
    execute: async (_toolCallId, params) => {
      const record = params as { id: string; node: unknown }
      const block = asNode(record.node)
      const note = await host.readNote(record.id)
      snapshots.set(record.id, serializeNote(note))
      const doc: TipTapNode = { ...note.doc, content: [...(note.doc.content ?? []), block] }
      await host.writeSerialized(record.id, serializeNote({ ...note, doc }))
      return toolText(`appended to ${record.id}`, { id: record.id })
    },
  }

  const write: AgentTool = {
    name: 'write_note',
    label: 'Write note',
    description: 'Replace one TipTap node at a content path. Other nodes stay untouched. Path [0] is the first block.',
    parameters: Type.Object({
      id: Type.String({ minLength: 1 }),
      path: Type.Array(Type.Number()),
      node: nodeSchema,
    }),
    execute: async (_toolCallId, params) => {
      const record = params as { id: string; path: unknown; node: unknown }
      const path = asPath(record.path)
      const replacement = asNode(record.node)
      const note = await host.readNote(record.id)
      snapshots.set(record.id, serializeNote(note))
      const doc = applyWrite(note.doc, path, replacement)
      await host.writeSerialized(record.id, serializeNote({ ...note, doc }))
      return toolText(`updated ${record.id} at ${path.join('.')}`, { id: record.id, path })
    },
  }

  const insert: AgentTool = {
    name: 'insert_block',
    label: 'Insert block',
    description: 'Insert one TipTap block at a top-level index. 0 inserts before the first block. Other blocks stay untouched.',
    parameters: Type.Object({
      id: Type.String({ minLength: 1 }),
      index: Type.Number(),
      node: nodeSchema,
    }),
    execute: async (_toolCallId, params) => {
      const record = params as { id: string; index: unknown; node: unknown }
      if (typeof record.index !== 'number') throw new Error('index out of range')
      const block = asNode(record.node)
      const note = await host.readNote(record.id)
      snapshots.set(record.id, serializeNote(note))
      const doc = insertBlock(note.doc, record.index, block)
      await host.writeSerialized(record.id, serializeNote({ ...note, doc }))
      return toolText(`inserted into ${record.id} at ${record.index}`, { id: record.id, index: record.index })
    },
  }

  const remove: AgentTool = {
    name: 'remove_block',
    label: 'Remove block',
    description: 'Remove one TipTap node at a content path. Other nodes stay untouched. Path [0] is the first block.',
    parameters: Type.Object({
      id: Type.String({ minLength: 1 }),
      path: Type.Array(Type.Number()),
    }),
    execute: async (_toolCallId, params) => {
      const record = params as { id: string; path: unknown }
      const path = asPath(record.path)
      const note = await host.readNote(record.id)
      snapshots.set(record.id, serializeNote(note))
      const doc = removeBlock(note.doc, path)
      await host.writeSerialized(record.id, serializeNote({ ...note, doc }))
      return toolText(`removed ${record.id} at ${path.join('.')}`, { id: record.id, path })
    },
  }

  const undo: AgentTool = {
    name: 'undo_note',
    label: 'Undo note write',
    description: 'Restore the note to the snapshot taken before the latest write in this turn. Does not delete a created note.',
    parameters: Type.Object({ id: Type.String({ minLength: 1 }) }),
    execute: async (_toolCallId, params) => {
      const id = (params as { id: string }).id
      const snapshot = snapshots.get(id)
      if (!snapshot) throw new Error('No snapshot')
      await host.writeSerialized(id, snapshot)
      snapshots.delete(id)
      return toolText(`restored ${id}`, { id })
    },
  }

  const setProperty: AgentTool = {
    name: 'set_property',
    label: 'Set property',
    description: 'Set one note property. kind is string, number, boolean, list, or date. value is text (true/false, a number, YYYY-MM-DD, or a list). Not for belongs_to, related_to, archived, or _ system keys.',
    parameters: Type.Object({
      id: Type.String({ minLength: 1 }),
      key: Type.String({ minLength: 1 }),
      kind: Type.Union(PROPERTY_KINDS.map((kind) => Type.Literal(kind))),
      value: Type.String(),
    }),
    execute: async (_toolCallId, params) => {
      const record = params as { id: string; key: string; kind: PropertyInputKind; value: unknown }
      const note = await host.readNote(record.id)
      const key = editablePropertyKey(note, record.key)
      const value = propertyValue(record.kind, asText(record.value, 'value'))
      const saved = await commit({ ...note, properties: { ...note.properties, [key]: value } })
      return toolText(JSON.stringify({ id: saved.id, key, value: saved.properties[key] }), { id: saved.id })
    },
  }

  const renameProperty: AgentTool = {
    name: 'rename_property',
    label: 'Rename property',
    description: 'Rename a property key and keep its value and position.',
    parameters: Type.Object({
      id: Type.String({ minLength: 1 }),
      from: Type.String({ minLength: 1 }),
      to: Type.String({ minLength: 1 }),
    }),
    execute: async (_toolCallId, params) => {
      const record = params as { id: string; from: string; to: string }
      const note = await host.readNote(record.id)
      const from = editablePropertyKey(note, record.from)
      const to = editablePropertyKey(note, record.to)
      if (!Object.hasOwn(note.properties, from)) throw new Error('Property not found')
      if (from === to) throw new Error('Property name is unchanged')
      if (Object.hasOwn(note.properties, to)) throw new Error('Property already exists')
      const properties: Record<string, NoteProperty> = {}
      for (const [key, value] of Object.entries(note.properties)) properties[key === from ? to : key] = value
      const saved = await commit({ ...note, properties })
      return toolText(JSON.stringify({ id: saved.id, from, to }), { id: saved.id })
    },
  }

  const removeProperty: AgentTool = {
    name: 'remove_property',
    label: 'Remove property',
    description: 'Remove one note property by key.',
    parameters: Type.Object({
      id: Type.String({ minLength: 1 }),
      key: Type.String({ minLength: 1 }),
    }),
    execute: async (_toolCallId, params) => {
      const record = params as { id: string; key: string }
      const note = await host.readNote(record.id)
      const key = editablePropertyKey(note, record.key)
      if (!Object.hasOwn(note.properties, key)) throw new Error('Property not found')
      const properties = { ...note.properties }
      delete properties[key]
      const saved = await commit({ ...note, properties })
      return toolText(`removed ${key} from ${saved.id}`, { id: saved.id, key })
    },
  }

  const link: AgentTool = {
    name: 'link_relation',
    label: 'Link relation',
    description: 'Add a belongs_to or related_to link from a note to another note. target is a note id or title. Stored as a wikilink property.',
    parameters: Type.Object({
      id: Type.String({ minLength: 1 }),
      kind: Type.Union([Type.Literal('belongs_to'), Type.Literal('related_to')]),
      target: Type.String({ minLength: 1 }),
    }),
    execute: async (_toolCallId, params) => {
      const record = params as { id: string; kind: StructuralRelation; target: string }
      if (record.kind !== 'belongs_to' && record.kind !== 'related_to') throw new Error('kind must be belongs_to or related_to')
      const notes = await host.loadNotes()
      const source = notes.find((note) => note.id === record.id) ?? await host.readNote(record.id)
      const target = resolveNote(notes, record.target)
      if (!target) throw new Error('Target note not found')
      if (target.id === source.id) throw new Error('A note cannot link to itself')
      const field = relationStorageKey(source.properties, record.kind)
      const saved = await commit({
        ...source,
        properties: { ...source.properties, [field]: addRelationTarget(source.properties[field], target.title) },
      })
      return toolText(JSON.stringify({ id: saved.id, field, targetId: target.id, title: target.title }), { id: saved.id })
    },
  }

  const unlink: AgentTool = {
    name: 'unlink_relation',
    label: 'Unlink relation',
    description: 'Remove a belongs_to or related_to target from a note. target is a note id or title.',
    parameters: Type.Object({
      id: Type.String({ minLength: 1 }),
      kind: Type.Union([Type.Literal('belongs_to'), Type.Literal('related_to')]),
      target: Type.String({ minLength: 1 }),
    }),
    execute: async (_toolCallId, params) => {
      const record = params as { id: string; kind: StructuralRelation; target: string }
      if (record.kind !== 'belongs_to' && record.kind !== 'related_to') throw new Error('kind must be belongs_to or related_to')
      const notes = await host.loadNotes()
      const source = notes.find((note) => note.id === record.id) ?? await host.readNote(record.id)
      const resolved = resolveNote(notes, record.target)
      const title = resolved?.title ?? record.target.trim()
      if (!title) throw new Error('Target is required')
      const field = relationStorageKey(source.properties, record.kind)
      if (!Object.hasOwn(source.properties, field)) throw new Error('Relation not found')
      const next = removeRelationTarget(source.properties[field], [title])
      const properties = { ...source.properties }
      if (next === undefined) delete properties[field]
      else properties[field] = next
      const saved = await commit({ ...source, properties })
      return toolText(JSON.stringify({ id: saved.id, field, target: title }), { id: saved.id })
    },
  }

  const createType: AgentTool = {
    name: 'create_type',
    label: 'Create type',
    description: 'Create a type document. icon is a short name such as note, briefcase, or user. color is one of gray, blue, teal, green, orange, purple, red, pink, yellow. gray means automatic.',
    parameters: Type.Object({
      title: Type.String({ minLength: 1 }),
      icon: Type.Optional(Type.String()),
      color: Type.Optional(Type.String()),
      sidebarLabel: Type.Optional(Type.String()),
      visible: Type.Optional(Type.Boolean()),
      summary: Type.Optional(Type.String()),
    }),
    execute: async (_toolCallId, params) => {
      const record = params as {
        title: string
        icon?: string
        color?: string
        sidebarLabel?: string
        visible?: boolean
        summary?: string
      }
      const title = typeTitleOrThrow(record.title)
      const notes = await host.loadNotes()
      if (notes.some((note) => isTypeDocument(note) && note.title === title)) throw new Error('A type with that title already exists')
      const created = await host.createNote(title)
      const properties: Record<string, NoteProperty> = {
        _icon: record.icon?.trim() || 'note',
        _color: record.color === undefined ? 'gray' : colorOrThrow(record.color),
        visible: record.visible === false ? 'false' : 'true',
        _order: nextTypeOrder(notes),
      }
      const label = record.sidebarLabel?.trim()
      if (label) properties._sidebar_label = label
      const summary = record.summary?.trim()
      const saved = await commit({
        ...created,
        title,
        type: 'Type',
        properties,
        doc: summary
          ? { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: summary }] }] }
          : created.doc,
      })
      return toolText(JSON.stringify(typePayload(saved)), { id: saved.id })
    },
  }

  const updateType: AgentTool = {
    name: 'update_type',
    label: 'Update type',
    description: 'Update a type document. A new title is applied to notes of that type and to saved views that filter on it. Omit a field to leave it unchanged. An empty sidebarLabel clears it.',
    parameters: Type.Object({
      id: Type.String({ minLength: 1 }),
      title: Type.Optional(Type.String()),
      icon: Type.Optional(Type.String()),
      color: Type.Optional(Type.String()),
      sidebarLabel: Type.Optional(Type.String()),
      visible: Type.Optional(Type.Boolean()),
      order: Type.Optional(Type.Number()),
    }),
    execute: async (_toolCallId, params) => {
      const record = params as {
        id: string
        title?: string
        icon?: string
        color?: string
        sidebarLabel?: string
        visible?: boolean
        order?: number
      }
      if (
        record.title === undefined
        && record.icon === undefined
        && record.color === undefined
        && record.sidebarLabel === undefined
        && record.visible === undefined
        && record.order === undefined
      ) throw new Error('Set a title, icon, color, sidebarLabel, visible, or order')
      const notes = await host.loadNotes()
      const current = notes.find((note) => note.id === record.id) ?? await host.readNote(record.id)
      if (!isTypeDocument(current)) throw new Error('Note is not a type document')
      const title = record.title === undefined ? current.title : typeTitleOrThrow(record.title)
      if (title !== current.title && notes.some((note) => note.id !== current.id && isTypeDocument(note) && note.title === title)) {
        throw new Error('A type with that title already exists')
      }
      const properties: Record<string, NoteProperty> = { ...current.properties }
      if (record.icon !== undefined) {
        const icon = record.icon.trim()
        if (!icon) throw new Error('Icon is required')
        properties._icon = icon
      }
      if (record.color !== undefined) properties._color = colorOrThrow(record.color)
      if (record.sidebarLabel !== undefined) {
        const label = record.sidebarLabel.trim()
        if (label) properties._sidebar_label = label
        else delete properties._sidebar_label
      }
      if (record.visible !== undefined) properties.visible = record.visible ? 'true' : 'false'
      if (record.order !== undefined) {
        if (typeof record.order !== 'number' || !Number.isFinite(record.order)) throw new Error('Order must be a finite number')
        properties._order = String(record.order)
      }
      if (title !== current.title) {
        for (const note of notes) {
          if (note.id === current.id || note.type !== current.title) continue
          await commit({ ...note, type: title })
        }
      }
      const saved = await commit({
        ...current,
        title,
        doc: title === current.title ? current.doc : applyTitle(current.doc, title),
        properties,
      })
      if (title !== current.title && host.views) {
        for (const item of await host.views.list()) {
          if (item.view.type !== current.title) continue
          await host.views.save({ file: item.file, view: { ...item.view, type: title } })
        }
      }
      return toolText(JSON.stringify({
        ...typePayload(saved),
        viewsUpdated: title !== current.title && Boolean(host.views),
      }), { id: saved.id })
    },
  }

  const saveView: AgentTool = {
    name: 'save_view',
    label: 'Save view',
    description: 'Create or update a saved view. Omit file to create. Pass file (the slug) to update. Filters use op eq, contains, or exists. sort key is mtime, title, or created.',
    parameters: Type.Object({
      name: Type.String({ minLength: 1 }),
      file: Type.Optional(Type.String()),
      icon: Type.Optional(Type.String()),
      color: Type.Optional(Type.String()),
      type: Type.Optional(Type.String()),
      archived: Type.Optional(Type.Boolean()),
      sort: Type.Optional(Type.Object({
        key: Type.Union([Type.Literal('mtime'), Type.Literal('title'), Type.Literal('created')]),
        dir: Type.Union([Type.Literal('asc'), Type.Literal('desc')]),
      })),
      propertyFilters: Type.Optional(Type.Array(Type.Object({
        key: Type.String({ minLength: 1 }),
        op: Type.Union([Type.Literal('eq'), Type.Literal('contains'), Type.Literal('exists')]),
        value: Type.Optional(Type.String()),
      }))),
    }),
    execute: async (_toolCallId, params) => {
      const record = params as {
        name: string
        file?: string
        icon?: string
        color?: string
        type?: string
        archived?: boolean
        sort?: { key: string; dir: string }
        propertyFilters?: { key: string; op: string; value?: string }[]
      }
      const saved = await requireViews().save({
        file: record.file,
        view: viewFromInput(record),
      })
      return toolText(JSON.stringify(saved), { file: saved.file })
    },
  }

  const deleteView: AgentTool = {
    name: 'delete_view',
    label: 'Delete view',
    description: 'Delete a saved view by its file slug. Notes are not deleted.',
    parameters: Type.Object({ file: Type.String({ minLength: 1 }) }),
    execute: async (_toolCallId, params) => {
      const file = (params as { file: string }).file
      await requireViews().remove(file)
      return toolText(`deleted view ${file}`, { file })
    },
  }

  return [
    readNote,
    readActive,
    search,
    list,
    backlinks,
    relations,
    listTypes,
    listViews,
    create,
    setNote,
    append,
    write,
    insert,
    remove,
    undo,
    setProperty,
    renameProperty,
    removeProperty,
    link,
    unlink,
    createType,
    updateType,
    saveView,
    deleteView,
  ]
}
