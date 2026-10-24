import { MemoryFileSystem } from '@stride/platform'
import { describe, expect, it } from 'vitest'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { createVaultNote, loadNotes, notePath, readNoteFile, saveNote } from './vault.ts'
import { noteForSave, plainText, type StrideNote, type TipTapNode } from './note.ts'
import { applyViewsOrder, deleteVaultView, listViews, readViewsOrder, saveVaultView } from './views.ts'
import { toolsForAgentMode, vaultTools, WRITE_VAULT_TOOLS, type VaultToolHost } from './vault-tools.ts'

function text(value: string): TipTapNode {
  return { type: 'text', text: value }
}

function paragraph(value: string): TipTapNode {
  return { type: 'paragraph', content: [text(value)] }
}

function richDoc(): TipTapNode {
  return {
    type: 'doc',
    content: [
      paragraph('OLD'),
      {
        type: 'taskList',
        content: [
          { type: 'taskItem', attrs: { checked: false }, content: [paragraph('open')] },
          { type: 'taskItem', attrs: { checked: true }, content: [paragraph('done')] },
        ],
      },
      {
        type: 'table',
        content: [
          {
            type: 'tableRow',
            content: [
              { type: 'tableHeader', content: [paragraph('H1')] },
              { type: 'tableCell', content: [paragraph('A')] },
            ],
          },
        ],
      },
      { type: 'image', attrs: { src: 'attachments/a.png' } },
      { type: 'callout', attrs: { kind: 'warning' }, content: [paragraph('careful')] },
      {
        type: 'paragraph',
        content: [
          { type: 'wikilink', attrs: { target: 'Other note', alias: 'other' } },
          text(' '),
        ],
      },
    ],
  }
}

async function call(tools: AgentTool[], name: string, params: unknown) {
  const tool = tools.find((item) => item.name === name)
  if (!tool) throw new Error(`missing ${name}`)
  const result = await tool.execute('call_test', params as never)
  return result.content.map((part) => (part.type === 'text' ? part.text : '')).join('')
}

function memoryHost(fs: MemoryFileSystem, extra: Partial<VaultToolHost> = {}): VaultToolHost {
  return {
    readNote: (id) => readNoteFile(fs, notePath(id), id),
    writeSerialized: (id, serialized) => fs.writeText(notePath(id), serialized),
    searchVault: async () => [],
    createNote: (title) => createVaultNote(fs, title),
    loadNotes: () => loadNotes(fs),
    views: {
      list: async () => applyViewsOrder(await listViews(fs), await readViewsOrder(fs)),
      save: (input) => saveVaultView(fs, input),
      remove: (file) => deleteVaultView(fs, file),
    },
    ...extra,
  }
}

describe('vault tools', () => {
  it('replaces one node and leaves the rest of a rich document unchanged', async () => {
    const fs = new MemoryFileSystem('/tmp/stride-vault-tools')
    const note: StrideNote = {
      id: 'rich',
      title: 'Rich',
      type: 'note',
      properties: {},
      doc: richDoc(),
    }
    await saveNote(fs, note)
    const before = await fs.readText(notePath('rich'))
    const loaded = await readNoteFile(fs, notePath('rich'), 'rich')
    const untouched = (loaded.doc.content ?? []).slice(1).map((node) => JSON.stringify(node))
    const tools = vaultTools(memoryHost(fs))

    const read = await call(tools, 'read_note', { id: 'rich' })
    expect(read).toContain('"type":"table"')
    expect(read).toContain('OLD')

    await call(tools, 'write_note', { id: 'rich', path: [0], node: paragraph('NEW') })
    const saved = await fs.readText(notePath('rich'))
    const again = await readNoteFile(fs, notePath('rich'), 'rich')
    expect((again.doc.content ?? []).slice(1).map((node) => JSON.stringify(node))).toEqual(untouched)
    expect(plainText(again.doc.content?.[0] ?? { type: 'doc' })).toBe('NEW')
    expect(saved).toContain('attachments/a.png')
    expect(saved).toContain('"checked": true')
    expect(saved).toContain('"kind": "warning"')
    expect(saved).toContain('"alias": "other"')
    expect(saved).toContain('"type": "table"')
    expect(saved).toContain('"type": "taskList"')
    expect(saved).toContain('"type": "wikilink"')
    expect(saved).toContain('"type": "image"')
    expect(saved).toContain('"type": "callout"')

    await call(tools, 'undo_note', { id: 'rich' })
    expect(await fs.readText(notePath('rich'))).toBe(before)
  })

  it('appends a block without rewriting earlier nodes', async () => {
    const fs = new MemoryFileSystem('/tmp/stride-vault-append')
    await saveNote(fs, { id: 'page', title: 'Page', type: 'note', properties: {}, doc: richDoc() })
    const loaded = await readNoteFile(fs, notePath('page'), 'page')
    const before = (loaded.doc.content ?? []).map((node) => JSON.stringify(node))
    const tools = vaultTools(memoryHost(fs))
    await call(tools, 'append_to_note', { id: 'page', node: paragraph('MORE') })
    const again = await readNoteFile(fs, notePath('page'), 'page')
    const content = again.doc.content ?? []
    expect(content.slice(0, before.length).map((node) => JSON.stringify(node))).toEqual(before)
    expect(plainText(content[content.length - 1] ?? { type: 'doc' })).toBe('MORE')
  })

  it('searches through the host and reads backlinks from the graph', async () => {
    const fs = new MemoryFileSystem('/tmp/stride-vault-search')
    const seen: string[] = []
    await saveNote(fs, {
      id: 'source',
      title: 'Source',
      type: 'note',
      properties: {},
      doc: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'wikilink', attrs: { target: 'Target', alias: null } }] }],
      },
    })
    await saveNote(fs, {
      id: 'target',
      title: 'Target',
      type: 'note',
      properties: {},
      doc: { type: 'doc', content: [paragraph('body')] },
    })
    const tools = vaultTools(memoryHost(fs, {
      searchVault: async (query) => {
        seen.push(query)
        return [{ id: 'target', title: 'Target', snippet: 'body' }]
      },
    }))
    const filesBefore = await fs.list('')
    const hits = await call(tools, 'search_vault', { query: 'body' })
    expect(seen).toEqual(['body'])
    expect(hits).toContain('target')
    expect(await fs.list('')).toEqual(filesBefore)
    const links = await call(tools, 'get_backlinks', { id: 'target' })
    expect(links).toContain('"sourceId":"source"')
    expect(links).toContain('"via":"body"')
    const listed = await call(tools, 'list_notes', {})
    expect(listed).toContain('source')
    const created = await call(tools, 'create_note', { title: 'Fresh page' })
    expect(created).toContain('Fresh page')
  })

  it('drops write tools in safe mode and returns the same array in power mode', () => {
    const fs = new MemoryFileSystem('/tmp/stride-vault-tools-mode')
    const tools = vaultTools(memoryHost(fs))
    const safe = toolsForAgentMode(tools, 'safe')
    const names = safe.map((tool) => tool.name)
    expect(names).toContain('search_vault')
    expect(names).toContain('read_note')
    expect(names).toContain('list_types')
    expect(names).toContain('list_views')
    expect(names).toContain('get_relations')
    for (const name of WRITE_VAULT_TOOLS) expect(names).not.toContain(name)
    expect(toolsForAgentMode(tools, 'power')).toBe(tools)
  })

  it('sets properties, links notes, and edits blocks without flattening the document', async () => {
    const fs = new MemoryFileSystem('/tmp/stride-vault-manage')
    await saveNote(fs, noteForSave({ id: 'page', title: 'Page', type: 'note', properties: { status: 'open' }, doc: richDoc() }))
    await saveNote(fs, { id: 'target', title: 'Target', type: 'note', properties: {}, doc: { type: 'doc', content: [paragraph('body')] } })
    const tools = vaultTools(memoryHost(fs))
    const untouched = ((await readNoteFile(fs, notePath('page'), 'page')).doc.content ?? []).map((node) => JSON.stringify(node))

    await call(tools, 'set_property', { id: 'page', key: 'rating', kind: 'number', value: '4' })
    await call(tools, 'rename_property', { id: 'page', from: 'status', to: 'state' })
    await call(tools, 'link_relation', { id: 'page', kind: 'belongs_to', target: 'target' })
    await call(tools, 'insert_block', { id: 'page', index: 1, node: paragraph('MID') })
    const edited = await readNoteFile(fs, notePath('page'), 'page')
    expect(edited.properties.rating).toBe(4)
    expect(edited.properties.state).toBe('open')
    expect(edited.properties.status).toBeUndefined()
    expect(edited.properties.belongs_to).toEqual(['[[Target]]'])
    const content = edited.doc.content ?? []
    expect(plainText(content[1] ?? { type: 'doc' })).toBe('MID')
    expect(content.filter((_, index) => index !== 1).map((node) => JSON.stringify(node))).toEqual(untouched)

    await call(tools, 'remove_block', { id: 'page', path: [1] })
    await call(tools, 'unlink_relation', { id: 'page', kind: 'belongs_to', target: 'Target' })
    await call(tools, 'remove_property', { id: 'page', key: 'rating' })
    const restored = await readNoteFile(fs, notePath('page'), 'page')
    expect(restored.properties.belongs_to).toBeUndefined()
    expect(restored.properties.rating).toBeUndefined()
    expect((restored.doc.content ?? []).map((node) => JSON.stringify(node))).toEqual(untouched)
    await expect(call(tools, 'set_property', { id: 'page', key: 'belongs_to', kind: 'string', value: '[[Target]]' })).rejects.toThrow('link_relation')
    const relations = await call(tools, 'get_relations', { id: 'target' })
    expect(relations).toContain('"backlinks"')
  })

  it('creates a type, retypes a note, and renames the type through instances and views', async () => {
    const fs = new MemoryFileSystem('/tmp/stride-vault-types')
    const tools = vaultTools(memoryHost(fs))
    const created = JSON.parse(await call(tools, 'create_type', { title: 'Project', color: 'blue', icon: 'briefcase' })) as { id: string }
    expect(created.id).toBeTruthy()
    const note = JSON.parse(await call(tools, 'create_note', { title: 'Bridge', type: 'Project' })) as { id: string; type: string }
    expect(note.type).toBe('Project')
    await call(tools, 'save_view', { name: 'Projects', type: 'Project', propertyFilters: [{ key: 'status', op: 'exists' }] })
    await call(tools, 'set_note', { id: note.id, archived: true })
    const archived = await readNoteFile(fs, notePath(note.id), note.id)
    expect(archived.properties.archived).toBe(true)
    expect(archived.id).toBe(note.id)

    await call(tools, 'update_type', { id: created.id, title: 'Effort', visible: false })
    const effort = await readNoteFile(fs, notePath(note.id), note.id)
    expect(effort.type).toBe('Effort')
    const typeDoc = await readNoteFile(fs, notePath(created.id), created.id)
    expect(typeDoc.title).toBe('Effort')
    expect(typeDoc.type).toBe('Type')
    expect(typeDoc.properties.visible).toBe('false')
    const views = JSON.parse(await call(tools, 'list_views', {})) as { file: string; view: { type?: string } }[]
    expect(views.map((item) => item.view.type)).toEqual(['Effort'])
    await call(tools, 'delete_view', { file: views[0]!.file })
    expect(await call(tools, 'list_views', {})).toBe('[]')
    const types = await call(tools, 'list_types', {})
    expect(types).toContain('Effort')
    await call(tools, 'undo_note', { id: note.id })
    expect((await readNoteFile(fs, notePath(note.id), note.id)).type).toBe('Project')
  })
})
