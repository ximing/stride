import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'
import { EmbeddingClient, maskSecret, noteIndex, saveNote, searchNotes, settingsContainRawKey, writeSettings, type AppSettings } from '@stride/core'
import { NodeFileSystem, NodeSecretsStore, openVaneSearch } from './index.ts'

const dirs: string[] = []
const servers: http.Server[] = []
const secrets = new NodeSecretsStore()

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stride-search-'))
  dirs.push(dir)
  return dir
}

function vectorFor(text: string): number[] {
  if (text.includes('alpha-note')) return [1, 0, 0, 0]
  if (text.includes('beta-note')) return [0, 1, 0, 0]
  if (text.includes('gamma-note')) return [0, 0, 1, 0]
  if (text.includes('nearest-alpha')) return [1, 0, 0, 0]
  return [0, 0, 0, 1]
}

async function embeddingServer(expectedKey: string): Promise<string> {
  const server = http.createServer((req, res) => {
    const auth = req.headers.authorization || ''
    if (auth !== `Bearer ${expectedKey}`) {
      res.writeHead(401)
      res.end('bad key')
      return
    }
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(chunk as Buffer))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { input?: string[] }
      const input = body.input ?? []
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        data: input.map((text, index) => ({ index, embedding: vectorFor(text) })),
      }))
    })
  })
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no port')
  return `http://127.0.0.1:${address.port}/v1`
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('vane search', () => {
  it('uses BM25 until an embedding key switches the query to hybrid', async () => {
    const dir = tempDir()
    const index = noteIndex(await openVaneSearch(path.join(dir, 'vane'), 4), 4)
    const notes = [
      { id: 'alpha', text: 'alpha-note xylophonequartz' },
      { id: 'beta', text: 'beta-note 本地优先笔记' },
      { id: 'gamma', text: 'gamma-note soup recipe' },
    ]
    await index.upsert(notes)
    const client = new EmbeddingClient(fetch)
    const english = await searchNotes(index, 'xylophonequartz', null, client)
    expect(client.calls).toBe(0)
    expect(english.mode).toBe('text')
    expect(english.hits.map((hit) => hit.id)).toEqual(['alpha'])

    const cjk = await searchNotes(index, '笔记', null, client)
    expect(client.calls).toBe(0)
    expect(cjk.hits.map((hit) => hit.id)).toEqual(['beta'])
    expect(index.lastQuery?.mode).toBe('text')

    const key = 'sk-stride-embed-test-key'
    const endpoint = await embeddingServer(key)
    const embedding = { endpoint, model: 'fixture-embed', apiKey: key, dim: 4 }
    const embedClient = new EmbeddingClient(fetch)
    const vectors = await embedClient.embed(notes.map((note) => note.text), embedding)
    await index.upsert(notes.map((note, i) => ({ ...note, vector: vectors[i] })))
    const hybrid = await searchNotes(index, 'nearest-alpha', embedding, embedClient)
    expect(hybrid.mode).toBe('hybrid')
    expect(index.lastQuery?.mode).toBe('hybrid')
    expect(hybrid.hits[0]?.id).toBe('alpha')
    expect(notes.some((note) => note.text.includes('nearest-alpha'))).toBe(false)
    await index.close()

    const settingsFile = path.join(dir, 'settings.json')
    const settings: AppSettings = {
      embedding,
      llmConfigs: [{ id: 'c1', name: 'OpenAI', provider: 'openai', model: 'm', baseUrl: endpoint, apiKey: key, isDefault: true }],
      releasesUrl: '',
      gitEnabled: true,
      autoSyncMinutes: 0,
      autoGitEnabled: false,
      autoGitIdleSeconds: 0,
      autoGitBlurSeconds: 0,
    }
    const settingsFs = new NodeFileSystem(dir)
    await writeSettings(settingsFs, 'settings.json', settings, secrets)
    expect(await settingsContainRawKey(settingsFs, 'settings.json', key)).toBe(false)
    expect(maskSecret(key)).toBe('••••-key')
    const vault = path.join(dir, 'vault')
    fs.mkdirSync(vault)
    const note = await saveNote(new NodeFileSystem(vault), {
      id: 'alpha',
      title: 'Alpha',
      type: 'note',
      properties: {},
      doc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'alpha-note' }] }] },
    })
    expect(fs.readFileSync(path.join(vault, `${note.id}.stride.json`), 'utf8').includes(key)).toBe(false)
    expect(settingsFile.endsWith('settings.json')).toBe(true)
  })
})
