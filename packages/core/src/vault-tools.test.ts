import { MemoryFileSystem, ShellAbortError, ShellDeniedError, ShellTimeoutError } from '@stride/platform'
import { describe, expect, it } from 'vitest'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { createVaultNote, loadNotes, notePath, readNoteFile, saveNote } from './vault.ts'
import { moveNotePath } from './folders.ts'
import { noteForSave, plainText, type StrideNote, type TipTapNode } from './note.ts'
import { applyViewsOrder, deleteVaultView, listViews, readViewsOrder, saveVaultView } from './views.ts'
import {
  emptyVaultTurn,
  toolsForAgentMode,
  VAULT_ASSISTANT_PROMPT,
  vaultTools,
  WRITE_VAULT_TOOLS,
  type VaultToolHost,
  type VaultTurnHolder,
} from './vault-tools.ts'

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
    async deleteNote(id) {
      await fs.remove(notePath(id))
    },
    async moveNote(id, destFolder) {
      if (destFolder !== '') {
        const stat = await fs.stat(destFolder)
        if (!stat || stat.kind !== 'directory') throw new Error('Folder not found')
      }
      return { id: await moveNotePath(fs, id, destFolder) }
    },
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
    await saveNote(fs, {
      id: 'kept',
      title: 'Kept',
      type: 'Project',
      properties: {},
      doc: { type: 'doc', content: [paragraph('stay')] },
    })
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
    await call(tools, 'undo_note', { id: 'kept' })
    expect((await readNoteFile(fs, notePath('kept'), 'kept')).type).toBe('Project')
    await call(tools, 'undo_note', { id: note.id })
    expect(await fs.stat(notePath(note.id))).toBeNull()
  })

  it('runs bash only in power mode and reports the exit code', async () => {
    const fs = new MemoryFileSystem('/tmp/stride-vault-bash')
    const seen: { command: string; timeout?: number }[] = []
    const tools = vaultTools(memoryHost(fs, {
      shell: {
        exec(command, options) {
          seen.push({ command, timeout: options?.timeout })
          return { stdout: 'from-hook', stderr: 'node: command not found', code: command === 'false' ? 1 : 0 }
        },
      },
    }))
    expect(toolsForAgentMode(tools, 'safe').map((tool) => tool.name)).not.toContain('bash')
    const ok = await call(tools, 'bash', { command: 'cat .git/hooks/pre-commit', timeout: 5 })
    expect(ok).toContain('from-hook')
    expect(ok).toContain('node: command not found')
    expect(seen).toEqual([{ command: 'cat .git/hooks/pre-commit', timeout: 5 }])

    const tool = tools.find((item) => item.name === 'bash')
    const failed = await tool?.execute('call_test', { command: 'false' })
    expect(failed?.isError).toBe(true)
    expect(failed?.content.map((part) => (part.type === 'text' ? part.text : '')).join('')).toContain('Command exited with code 1')
    await expect(call(tools, 'bash', { command: 'echo', timeout: 0 })).rejects.toThrow('Invalid timeout')
    await expect(call(vaultTools(memoryHost(fs)), 'bash', { command: 'echo' })).rejects.toThrow('Shell is not available')
  })

  it('keeps the tail of a long bash result and surfaces abort and timeout', async () => {
    const fs = new MemoryFileSystem('/tmp/stride-vault-bash-tail')
    const lines = Array.from({ length: 2_005 }, (_, index) => `line-${index}`)
    const tools = vaultTools(memoryHost(fs, {
      shell: {
        exec(command) {
          if (command === 'abort') return Promise.reject(new ShellAbortError({ stdout: 'stopped', stderr: '', code: null }))
          if (command === 'timeout') return Promise.reject(new ShellTimeoutError(3, { stdout: 'slow', stderr: '', code: null }))
          return { stdout: lines.join('\n'), stderr: '', code: 0 }
        },
      },
    }))
    const text = await call(tools, 'bash', { command: 'yes' })
    expect(text).toContain('line-2004')
    expect(text).not.toContain('line-0\n')
    expect(text).toContain('Output truncated')
    const tool = tools.find((item) => item.name === 'bash')
    const aborted = await tool?.execute('call_test', { command: 'abort' })
    expect(aborted?.isError).toBe(true)
    expect(aborted?.content.map((part) => (part.type === 'text' ? part.text : '')).join('')).toContain('Command aborted')
    const timed = await tool?.execute('call_test', { command: 'timeout' })
    expect(timed?.content.map((part) => (part.type === 'text' ? part.text : '')).join('')).toContain('Command timed out after 3 seconds')
  })

  it('returns a denied bash result when the host throws ShellDeniedError', async () => {
    const fs = new MemoryFileSystem('/tmp/stride-vault-bash-denied')
    const tools = vaultTools(memoryHost(fs, {
      shell: {
        exec() {
          return Promise.reject(new ShellDeniedError('unsafe command'))
        },
      },
    }))
    const tool = tools.find((item) => item.name === 'bash')
    const denied = await tool?.execute('call_test', { command: 'rm -rf /' })
    const body = denied?.content.map((part) => (part.type === 'text' ? part.text : '')).join('') ?? ''
    expect(denied?.isError).toBe(true)
    expect(body).toContain('Command denied:')
    expect(body).toContain('unsafe command')
    expect(body).not.toContain('(no output)')
    expect(denied?.details).toEqual({ denied: true })
    console.log(body)
  })

  it('returns Command denied: denied when the ShellDeniedError reason is blank', async () => {
    const fs = new MemoryFileSystem('/tmp/stride-vault-bash-denied-blank')
    const tools = vaultTools(memoryHost(fs, {
      shell: {
        exec() {
          return Promise.reject(new ShellDeniedError('   '))
        },
      },
    }))
    const tool = tools.find((item) => item.name === 'bash')
    const denied = await tool?.execute('call_test', { command: 'echo' })
    const body = denied?.content.map((part) => (part.type === 'text' ? part.text : '')).join('') ?? ''
    expect(denied?.isError).toBe(true)
    expect(body).toContain('Command denied: denied')
    expect(body).not.toContain('(no output)')
    expect(denied?.details).toEqual({ denied: true })
    console.log(body)
  })

  it('lets power delete and move, and tells the model not to rewrite note files from the shell', () => {
    const fs = new MemoryFileSystem('/tmp/stride-vault-delete-move-mode')
    const tools = vaultTools(memoryHost(fs))
    const safe = toolsForAgentMode(tools, 'safe').map((tool) => tool.name)
    expect(safe).not.toContain('delete_note')
    expect(safe).not.toContain('move_note')
    expect(toolsForAgentMode(tools, 'power').map((tool) => tool.name)).toEqual(expect.arrayContaining(['delete_note', 'move_note']))
    expect(VAULT_ASSISTANT_PROMPT).toContain('delete_note')
    expect(VAULT_ASSISTANT_PROMPT).toContain('move_note')
    expect(VAULT_ASSISTANT_PROMPT).toContain('Do not rewrite *.stride.json from the shell.')
    expect(VAULT_ASSISTANT_PROMPT).not.toContain('Do not delete notes')
    expect(VAULT_ASSISTANT_PROMPT).toContain('created this turn')
    const undo = tools.find((tool) => tool.name === 'undo_note')
    expect(undo?.description).toContain('created this turn')
    expect(undo?.description).not.toContain('Does not delete')
  })

  it('undo deletes a note created this turn, including a typed create that later committed', async () => {
    const fs = new MemoryFileSystem('/tmp/stride-vault-undo-created')
    const tools = vaultTools(memoryHost(fs))
    const bare = JSON.parse(await call(tools, 'create_note', { title: 'Fresh page' })) as { id: string }
    await call(tools, 'undo_note', { id: bare.id })
    expect(await fs.stat(notePath(bare.id))).toBeNull()

    await call(tools, 'create_type', { title: 'Project', color: 'blue' })
    const typed = JSON.parse(await call(tools, 'create_note', { title: 'Bridge', type: 'Project' })) as { id: string; type: string }
    expect(typed.type).toBe('Project')
    await call(tools, 'set_note', { id: typed.id, archived: true })
    expect((await readNoteFile(fs, notePath(typed.id), typed.id)).properties.archived).toBe(true)
    await call(tools, 'undo_note', { id: typed.id })
    expect(await fs.stat(notePath(typed.id))).toBeNull()
  })

  it('does not treat an id that already existed as created, and restores its last write', async () => {
    const fs = new MemoryFileSystem('/tmp/stride-vault-undo-existing')
    await saveNote(fs, {
      id: 'bridge',
      title: 'Bridge',
      type: 'note',
      properties: {},
      doc: { type: 'doc', content: [paragraph('old')] },
    })
    const tools = vaultTools(memoryHost(fs, {
      createNote: async () => readNoteFile(fs, notePath('bridge'), 'bridge'),
    }))
    const typed = JSON.parse(await call(tools, 'create_note', { title: 'Bridge', type: 'Project' })) as { id: string; type: string }
    expect(typed).toMatchObject({ id: 'bridge', type: 'Project' })
    await call(tools, 'undo_note', { id: 'bridge' })
    const restored = await readNoteFile(fs, notePath('bridge'), 'bridge')
    expect(restored.type).toBe('note')
    expect(plainText(restored.doc)).toBe('old')
  })

  it('restores a deleted note from its tombstone and refuses to delete a type document', async () => {
    const fs = new MemoryFileSystem('/tmp/stride-vault-tombstone')
    await saveNote(fs, { id: 'page', title: 'Page', type: 'note', properties: {}, doc: { type: 'doc', content: [paragraph('keep')] } })
    await saveNote(fs, { id: 'kind', title: 'Kind', type: 'Type', properties: {}, doc: { type: 'doc', content: [paragraph('type')] } })
    const before = await fs.readText(notePath('page'))
    const tools = vaultTools(memoryHost(fs))
    await expect(call(tools, 'delete_note', { id: 'kind' })).rejects.toThrow('Cannot delete a type document')
    expect(await fs.stat(notePath('kind'))).not.toBeNull()
    await call(tools, 'delete_note', { id: 'page' })
    expect(await fs.stat(notePath('page'))).toBeNull()
    await call(tools, 'undo_note', { id: 'page' })
    expect(await fs.readText(notePath('page'))).toBe(before)
    await expect(call(tools, 'undo_note', { id: 'page' })).rejects.toThrow('No snapshot')
  })

  it('prefers a write snapshot over a later tombstone for a note that already existed', async () => {
    const fs = new MemoryFileSystem('/tmp/stride-vault-snapshot-before-tomb')
    await saveNote(fs, { id: 'page', title: 'Page', type: 'note', properties: {}, doc: { type: 'doc', content: [paragraph('OLD')] } })
    const before = await fs.readText(notePath('page'))
    const tools = vaultTools(memoryHost(fs))
    await call(tools, 'append_to_note', { id: 'page', node: paragraph('MORE') })
    await call(tools, 'delete_note', { id: 'page' })
    expect(await fs.stat(notePath('page'))).toBeNull()
    await call(tools, 'undo_note', { id: 'page' })
    expect(await fs.readText(notePath('page'))).toBe(before)
  })

  it('rejects unsafe move paths, does not create a folder, and records both ids', async () => {
    const fs = new MemoryFileSystem('/tmp/stride-vault-move')
    await saveNote(fs, { id: 'alpha', title: 'Alpha', type: 'note', properties: {}, doc: { type: 'doc', content: [paragraph('a')] } })
    await fs.mkdir('box')
    const seen: string[] = []
    const turns: VaultTurnHolder = { current: emptyVaultTurn() }
    const tools = vaultTools(memoryHost(fs, {
      moveNote: async (id, destFolder) => {
        seen.push(destFolder)
        if (destFolder !== '') {
          const stat = await fs.stat(destFolder)
          if (!stat || stat.kind !== 'directory') throw new Error('Folder not found')
        }
        return { id: await moveNotePath(fs, id, destFolder) }
      },
    }), turns)
    for (const destFolder of ['/tmp', 'C:/vault', '..', 'a/../b', 'a\\b', 'a//b', 'a/', '/']) {
      await expect(call(tools, 'move_note', { id: 'alpha', destFolder })).rejects.toThrow('Invalid folder')
    }
    expect(seen).toEqual([])
    await expect(call(tools, 'move_note', { id: 'alpha', destFolder: 'missing' })).rejects.toThrow('Folder not found')
    expect(await fs.stat('missing')).toBeNull()
    expect(await fs.stat(notePath('alpha'))).not.toBeNull()
    expect(turns.current?.moved.size).toBe(0)

    const moved = JSON.parse(await call(tools, 'move_note', { id: 'alpha', destFolder: 'box' })) as { id: string; from: string }
    expect(moved).toEqual({ id: 'box/alpha', from: 'alpha' })
    expect(await fs.stat(notePath('alpha'))).toBeNull()
    expect(await fs.stat(notePath('box/alpha'))).not.toBeNull()
    expect([...(turns.current?.moved ?? [])].sort()).toEqual(['alpha', 'box/alpha'])

    turns.current = emptyVaultTurn()
    const rooted = JSON.parse(await call(tools, 'move_note', { id: 'box/alpha', destFolder: '' })) as { id: string }
    expect(rooted.id).toBe('alpha')
    expect([...(turns.current?.moved ?? [])].sort()).toEqual(['alpha', 'box/alpha'])
  })

  it('reads replacement turn maps at call time, including a clear of the same maps', async () => {
    const fs = new MemoryFileSystem('/tmp/stride-vault-turn-holder')
    await saveNote(fs, { id: 'page', title: 'Page', type: 'note', properties: {}, doc: { type: 'doc', content: [paragraph('OLD')] } })
    const turns: VaultTurnHolder = { current: emptyVaultTurn() }
    const tools = vaultTools(memoryHost(fs), turns)
    await call(tools, 'append_to_note', { id: 'page', node: paragraph('MORE') })
    expect(turns.current?.snapshots.has('page')).toBe(true)
    turns.current = emptyVaultTurn()
    await expect(call(tools, 'undo_note', { id: 'page' })).rejects.toThrow('No snapshot')
    await call(tools, 'append_to_note', { id: 'page', node: paragraph('AGAIN') })
    turns.current?.snapshots.clear()
    turns.current?.created.clear()
    turns.current?.tombstones.clear()
    turns.current?.moved.clear()
    await expect(call(tools, 'undo_note', { id: 'page' })).rejects.toThrow('No snapshot')
  })
})
