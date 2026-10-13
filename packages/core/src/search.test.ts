import { describe, expect, it } from 'vitest'
import { MemoryFileSystem, MemorySearchBackend, MemorySecretsStore } from '@stride/platform'
import { EmbeddingClient } from './embeddings.ts'
import { noteIndex, searchNotes } from './search.ts'
import {
  defaultSettings,
  defaultSettingsPath,
  maskSecret,
  publicSettings,
  readSettings,
  settingsContainRawKey,
  writeSettings,
  type AppSettings,
} from './settings.ts'
import { saveNote } from './vault.ts'

describe('search notes', () => {
  it('ranks text overlaps and switches to hybrid when an embedding key is set', async () => {
    const backend = new MemorySearchBackend()
    const index = noteIndex(backend, 4)
    const notes = [
      { id: 'alpha', text: 'alpha-note xylophonequartz' },
      { id: 'beta', text: 'beta-note local note' },
      { id: 'gamma', text: 'gamma-note soup recipe' },
    ]
    await index.upsert(notes)
    const client = new EmbeddingClient(async () => {
      throw new Error('text search must not embed')
    })
    const english = await searchNotes(index, 'xylophonequartz', null, client)
    expect(client.calls).toBe(0)
    expect(english.mode).toBe('text')
    expect(english.hits.map((hit) => hit.id)).toEqual(['alpha'])
    expect(index.lastQuery?.mode).toBe('text')

    const embedClient = new EmbeddingClient(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { input?: string[] }
      const input = body.input ?? []
      return new Response(JSON.stringify({
        data: input.map((_text, index) => ({ index, embedding: [1, 0, 0, 0] })),
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    const embedding = { endpoint: 'http://127.0.0.1/v1', model: 'fixture-embed', apiKey: 'sk-stride-embed-test-key', dim: 4 }
    const hybrid = await searchNotes(index, 'xylophonequartz', embedding, embedClient)
    expect(embedClient.calls).toBe(1)
    expect(hybrid.mode).toBe('hybrid')
    expect(index.lastQuery?.mode).toBe('hybrid')
    expect(index.lastQuery?.vector).toEqual([1, 0, 0, 0])
    expect(hybrid.hits[0]?.id).toBe('alpha')
    await index.close()
  })

  it('seals settings keys and does not write them into a note', async () => {
    const files = new MemoryFileSystem('/virtual/settings')
    const secrets = new MemorySecretsStore()
    const key = 'sk-stride-embed-test-key'
    const settings: AppSettings = {
      embedding: { endpoint: 'http://127.0.0.1/v1', model: 'fixture-embed', apiKey: key, dim: 4 },
      llm: { provider: 'fixture', model: 'm', baseUrl: 'http://127.0.0.1/v1', apiKey: key },
      releasesUrl: '',
    }
    await writeSettings(files, 'settings.json', settings, secrets)
    expect(await settingsContainRawKey(files, 'settings.json', key)).toBe(false)
    expect(maskSecret(key)).toBe('••••-key')
    const loaded = await readSettings(files, 'settings.json', secrets)
    expect(loaded.embedding.apiKey).toBe(key)
    expect(loaded.llm.apiKey).toBe(key)
    expect(publicSettings(loaded).embedding.keyMask).toBe('••••-key')
    expect(await secrets.seal('')).toBe('')
    expect(await secrets.open('')).toBe('')
    await writeSettings(files, 'empty.json', defaultSettings(), secrets)
    expect((await readSettings(files, 'empty.json', secrets)).embedding.apiKey).toBe('')
    expect(defaultSettingsPath('/Users/someone')).toBe('/Users/someone/.stride/settings.json')
    expect(defaultSettingsPath('/Users/someone', '/tmp/custom.json')).toBe('/tmp/custom.json')

    const vault = new MemoryFileSystem('/virtual/vault')
    const note = await saveNote(vault, {
      id: 'alpha',
      title: 'Alpha',
      type: 'note',
      properties: {},
      doc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'alpha-note' }] }] },
    })
    expect((await vault.readText(`${note.id}.stride.json`)).includes(key)).toBe(false)
  })
})
