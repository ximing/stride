import { describe, expect, it } from 'vitest'
import { MemoryFileSystem, MemorySearchBackend, MemorySecretsStore } from '@stride/platform'
import { EmbeddingClient } from './embeddings.ts'
import { noteIndex, noteRebuilder, searchNotes } from './search.ts'
import {
  defaultLlmConfig,
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
    expect(english.hits[0]?.snippet).toContain('xylophonequartz')
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
    expect(hybrid.degraded).toBe(false)
    await index.close()
  })

  it('does not embed and reports degraded false when no embedding key is set', async () => {
    const backend = new MemorySearchBackend()
    const index = noteIndex(backend, 4)
    await index.upsert([{ id: 'alpha', text: 'alpha xylophonequartz' }])
    const client = new EmbeddingClient(async () => {
      throw new Error('text search must not embed')
    })
    const missing = await searchNotes(index, 'xylophonequartz', null, client)
    expect(client.calls).toBe(0)
    expect(missing).toMatchObject({ mode: 'text', degraded: false })
    expect(missing.hits.map((hit) => hit.id)).toEqual(['alpha'])
    const emptied = await searchNotes(index, 'xylophonequartz', {
      endpoint: 'http://127.0.0.1/v1',
      model: 'fixture-embed',
      apiKey: '',
      dim: 4,
    }, client)
    expect(client.calls).toBe(0)
    expect(emptied.degraded).toBe(false)
    expect(index.lastQuery?.mode).toBe('text')
    expect(index.lastQuery?.vector).toBeUndefined()
    await index.close()
  })

  it('falls back to text search when embed fails or the vector length mismatches dim', async () => {
    const backend = new MemorySearchBackend()
    const index = noteIndex(backend, 4)
    await index.upsert([
      { id: 'alpha', text: 'alpha xylophonequartz' },
      { id: 'beta', text: 'beta soup' },
    ])
    const embedding = { endpoint: 'http://127.0.0.1/v1', model: 'fixture-embed', apiKey: 'sk-stride-embed-test-key', dim: 4 }
    const failing = new EmbeddingClient(async () => new Response('no', { status: 503 }))
    const failed = await searchNotes(index, 'xylophonequartz', embedding, failing)
    expect(failing.calls).toBe(1)
    expect(failed.mode).toBe('text')
    expect(failed.degraded).toBe(true)
    expect(failed.hits.map((hit) => hit.id)).toEqual(['alpha'])
    expect(index.lastQuery?.mode).toBe('text')
    expect(index.lastQuery?.vector).toBeUndefined()

    const short = new EmbeddingClient(async () => new Response(JSON.stringify({
      data: [{ index: 0, embedding: [1, 0, 0] }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const mismatched = await searchNotes(index, 'xylophonequartz', embedding, short)
    expect(short.calls).toBe(1)
    expect(mismatched.mode).toBe('text')
    expect(mismatched.degraded).toBe(true)
    expect(index.lastQuery?.vector).toBeUndefined()

    const broken = {
      async search(): Promise<never> {
        throw new Error('index down')
      },
    }
    const embedDown = new EmbeddingClient(async () => {
      throw new Error('embed down')
    })
    await expect(searchNotes(broken, 'xylophonequartz', embedding, embedDown)).rejects.toThrow('index down')
    await index.close()
  })

  it('seals settings keys and does not write them into a note', async () => {
    const files = new MemoryFileSystem('/virtual/settings')
    const secrets = new MemorySecretsStore()
    const key = 'sk-stride-embed-test-key'
    const settings: AppSettings = {
      embedding: { endpoint: 'http://127.0.0.1/v1', model: 'fixture-embed', apiKey: key, dim: 4 },
      llmConfigs: [{ id: 'c1', name: 'OpenAI', provider: 'openai', model: 'm', baseUrl: 'http://127.0.0.1/v1', apiKey: key, isDefault: true }],
      releasesUrl: '',
      gitEnabled: true,
      autoSyncMinutes: 0,
      autoGitEnabled: false,
      autoGitIdleSeconds: 0,
      autoGitBlurSeconds: 0,
    }
    await writeSettings(files, 'settings.json', settings, secrets)
    expect(await settingsContainRawKey(files, 'settings.json', key)).toBe(false)
    expect(maskSecret(key)).toBe('••••-key')
    const loaded = await readSettings(files, 'settings.json', secrets)
    expect(loaded.embedding.apiKey).toBe(key)
    expect(defaultLlmConfig(loaded)?.apiKey).toBe(key)
    expect(publicSettings(loaded).embedding.keyMask).toBe('••••-key')
    expect(await secrets.seal('')).toBe('')
    expect(await secrets.open('')).toBe('')
    await writeSettings(files, 'empty.json', defaultSettings(), secrets)
    expect((await readSettings(files, 'empty.json', secrets)).embedding.apiKey).toBe('')
    expect((await readSettings(files, 'empty.json', secrets)).embedding.dim).toBe(4)
    await writeSettings(files, 'zero-dim.json', {
      embedding: { endpoint: 'http://127.0.0.1/v1', model: 'fixture-embed', apiKey: '', dim: 0 },
      llmConfigs: [],
      releasesUrl: '',
      gitEnabled: true,
      autoSyncMinutes: 0,
      autoGitEnabled: false,
      autoGitIdleSeconds: 0,
      autoGitBlurSeconds: 0,
    }, secrets)
    expect((await readSettings(files, 'zero-dim.json', secrets)).embedding.dim).toBe(0)
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

  it('rebuilds 1000 short notes from 0 to 1000, can stop, and stays under 5000ms', async () => {
    const docs = Array.from({ length: 1000 }, (_, index) => ({
      id: `n${index}`,
      text: `short note ${index} uniquequark${index}`,
    }))
    const backend = new MemorySearchBackend()
    const session = noteRebuilder(backend)
    const progress: number[] = []
    const started = performance.now()
    const result = await session.rebuild(docs, {
      onProgress: (done) => {
        progress.push(done)
      },
    })
    const elapsed = performance.now() - started
    console.info(`T3.2 rebuild 1000 notes: ${elapsed.toFixed(1)}ms`)
    expect(result.aborted, `rebuild took ${elapsed.toFixed(1)}ms`).toBe(false)
    expect(progress[0]).toBe(0)
    expect(progress[progress.length - 1]).toBe(1000)
    for (let index = 1; index < progress.length; index += 1) {
      expect(progress[index]).toBeGreaterThanOrEqual(progress[index - 1] ?? 0)
    }
    expect(elapsed, `rebuild took ${elapsed.toFixed(1)}ms`).toBeLessThan(5000)

    const stoppedBackend = new MemorySearchBackend()
    const stopped = noteRebuilder(stoppedBackend)
    let allow = true
    const stoppedProgress: number[] = []
    const stoppedResult = await stopped.rebuild(docs, {
      shouldContinue: () => allow,
      onProgress: (done) => {
        stoppedProgress.push(done)
        if (done > 0) allow = false
      },
    })
    expect(stoppedResult.aborted).toBe(true)
    expect(stoppedProgress[0]).toBe(0)
    expect(stoppedProgress[stoppedProgress.length - 1] ?? 1000).toBeLessThan(1000)
    const early = await stoppedBackend.search({ text: 'uniquequark0', topK: 5, mode: 'text' })
    expect(early.map((hit) => hit.id)).toEqual(['n0'])
    const late = await stoppedBackend.search({ text: 'uniquequark999', topK: 5, mode: 'text' })
    expect(late).toEqual([])
    await backend.close()
    await stoppedBackend.close()
  })

  it('keeps a live upsert ahead of the rebuild snapshot', async () => {
    const backend = new MemorySearchBackend()
    const session = noteRebuilder(backend)
    const docs = Array.from({ length: 12 }, (_, index) => ({
      id: `n${index}`,
      text: `snapshot-old oldtoken${index}`,
    }))
    const result = await session.rebuild(docs, {
      batchSize: 4,
      onProgress: async (done) => {
        if (done !== 4) return
        await session.upsert([{ id: 'n1', text: 'live-fresh freshtoken' }])
        await session.upsert([{ id: 'n9', text: 'live-later latertoken' }])
        await session.remove(['n2'])
      },
    })
    expect(result.aborted).toBe(false)
    const fresh = await backend.search({ text: 'freshtoken', topK: 5, mode: 'text' })
    expect(fresh.map((hit) => hit.id)).toEqual(['n1'])
    const stale = await backend.search({ text: 'oldtoken1', topK: 12, mode: 'text' })
    expect(stale.some((hit) => hit.id === 'n1')).toBe(false)
    const later = await backend.search({ text: 'latertoken', topK: 5, mode: 'text' })
    expect(later.map((hit) => hit.id)).toEqual(['n9'])
    const laterStale = await backend.search({ text: 'oldtoken9', topK: 12, mode: 'text' })
    expect(laterStale.some((hit) => hit.id === 'n9')).toBe(false)
    const removed = await backend.search({ text: 'oldtoken2', topK: 12, mode: 'text' })
    expect(removed.some((hit) => hit.id === 'n2')).toBe(false)
    await backend.close()
  })
})
