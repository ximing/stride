import { MemoryFileSystem } from '@stride/platform'
import { describe, expect, it } from 'vitest'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { createVaultNote, loadNotes, notePath, readNoteFile, saveNote } from './vault.ts'
import { plainText, type StrideNote, type TipTapNode } from './note.ts'
import { vaultTools, type VaultToolHost } from './vault-tools.ts'

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
    listNotes: async () => (await loadNotes(fs)).map((note) => ({ id: note.id, title: note.title })),
    createNote: (title) => createVaultNote(fs, title),
    loadNotes: () => loadNotes(fs),
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
})
