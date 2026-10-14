import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'
import { buildGraph, relationsOf } from './graph.ts'
import { plainText, serializeNote, type StrideNote, type TipTapNode } from './note.ts'

export const WRITE_VAULT_TOOLS = ['write_note', 'append_to_note', 'create_note', 'undo_note'] as const

export function toolsForAgentMode(tools: AgentTool[], mode: 'safe' | 'power'): AgentTool[] {
  if (mode === 'power') return tools
  const blocked = new Set<string>(WRITE_VAULT_TOOLS)
  return tools.filter((tool) => !blocked.has(tool.name))
}

export interface VaultToolHost {
  readNote(id: string): Promise<StrideNote> | StrideNote
  writeSerialized(id: string, serialized: string): Promise<void> | void
  searchVault(query: string): Promise<{ id: string; title: string; snippet: string }[]> | { id: string; title: string; snippet: string }[]
  listNotes(): Promise<{ id: string; title: string }[]> | { id: string; title: string }[]
  createNote(title: string): Promise<StrideNote> | StrideNote
  loadNotes(): Promise<StrideNote[]> | StrideNote[]
  activeNoteId?: string
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

export function applyWrite(node: TipTapNode, path: number[], replacement: TipTapNode): TipTapNode {
  const [head, ...rest] = path
  if (head === undefined || head < 0) throw new Error('path not found')
  const content = [...(node.content ?? [])]
  const current = content[head]
  if (current === undefined) throw new Error('path not found')
  content[head] = rest.length === 0 ? replacement : applyWrite(current, rest, replacement)
  return { ...node, content }
}

const nodeSchema = Type.Object({ type: Type.String({ minLength: 1 }) }, { additionalProperties: true })

export function vaultTools(host: VaultToolHost): AgentTool[] {
  const snapshots = new Map<string, string>()

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
    description: 'List note ids and titles.',
    parameters: Type.Object({}),
    execute: async () => toolText(JSON.stringify(await host.listNotes())),
  }

  const backlinks: AgentTool = {
    name: 'get_backlinks',
    label: 'Get backlinks',
    description: 'List notes that link to a note.',
    parameters: Type.Object({ id: Type.String({ minLength: 1 }) }),
    execute: async (_toolCallId, params) => {
      const id = (params as { id: string }).id
      const notes = await host.loadNotes()
      const links = relationsOf(buildGraph(notes), id).backlinks
      return toolText(JSON.stringify(links), { id })
    },
  }

  const create: AgentTool = {
    name: 'create_note',
    label: 'Create note',
    description: 'Create a new note.',
    parameters: Type.Object({ title: Type.String({ minLength: 1 }) }),
    execute: async (_toolCallId, params) => {
      const title = (params as { title: string }).title
      const note = await host.createNote(title)
      return toolText(JSON.stringify(notePayload(note)), { id: note.id })
    },
  }

  const remember = async (id: string) => {
    const note = await host.readNote(id)
    snapshots.set(id, serializeNote(note))
    return note
  }

  const append: AgentTool = {
    name: 'append_to_note',
    label: 'Append to note',
    description: 'Append one TipTap block. Existing blocks stay untouched.',
    parameters: Type.Object({ id: Type.String({ minLength: 1 }), node: nodeSchema }),
    execute: async (_toolCallId, params) => {
      const record = params as { id: string; node: unknown }
      const block = asNode(record.node)
      const note = await remember(record.id)
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
      const note = await remember(record.id)
      const doc = applyWrite(note.doc, path, replacement)
      await host.writeSerialized(record.id, serializeNote({ ...note, doc }))
      return toolText(`updated ${record.id} at ${path.join('.')}`, { id: record.id, path })
    },
  }

  const undo: AgentTool = {
    name: 'undo_note',
    label: 'Undo note write',
    description: 'Restore the note to the snapshot taken before the latest write or append.',
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

  return [readNote, readActive, search, list, backlinks, create, append, write, undo]
}
