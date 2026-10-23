import { isObservable, observer, register, resolve, useService } from '@rabjs/react'
import { docsForRebuild, planSync, type BaselineNote, type CacheNote } from '@stride/core'
import { MemoryFileSystem, MemorySecretsStore } from '@stride/platform'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StatusBar } from '../../ui/shell/status-bar'
import { CommandService } from '../commands/command.service'
import { GitService } from '../git/git.service'
import { LayoutService } from '../layout/layout.service'
import { ListFilterService } from '../search/list-filter.service'
import { resetSecretsStore, setSecretsStore, SettingsService } from '../settings/settings.service'
import { SettingsPageService } from '../settings/settings-page.service'
import { UpdateCheckService } from '../update/update-check'
import { FolderService } from './folder.service'
import { embeddingClient, searchSlot, VaultService } from './vault.service'

function useMemoryFixture() {
  window.history.replaceState(null, '', '/?fixture=memory')
}

function registerVault() {
  register(VaultService)
  register(FolderService)
  register(ListFilterService)
  register(SettingsService)
  register(GitService)
  register(LayoutService)
  register(SettingsPageService)
  register(UpdateCheckService)
  register(CommandService)
}

async function settle(vault: VaultService) {
  for (let attempt = 0; attempt < 50 && (vault.indexPhase === 'rebuilding' || vault.indexWork === 'indexing'); attempt += 1) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 0))
  }
}

function embedFetch(vectors: number[][] | 'fail') {
  return vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (vectors === 'fail') return new Response('no', { status: 500 })
    const body = JSON.parse(String(init?.body ?? '{}')) as { input?: string[] }
    const input = body.input ?? []
    const rows = input.map((_text, index) => ({ index, embedding: vectors[index] ?? vectors[0] ?? [1, 0, 0, 0] }))
    return new Response(JSON.stringify({ data: rows }), { status: 200, headers: { 'content-type': 'application/json' } })
  })
}

describe('vault search cache', () => {
  afterEach(() => {
    window.history.replaceState(null, '', '/')
    vi.unstubAllGlobals()
    resetSecretsStore()
    embeddingClient.calls = 0
  })

  it('reuses vectors on the second open and embeds one edited note', async () => {
    useMemoryFixture()
    setSecretsStore(new MemorySecretsStore())
    const fetchMock = embedFetch([[1, 0, 0, 0]])
    vi.stubGlobal('fetch', fetchMock)
    registerVault()
    const vault = resolve(VaultService)
    const settings = resolve(SettingsService)
    const fs = new MemoryFileSystem('cache-vault')
    await vault.openClonedVault(fs)
    await vault.createNote()
    settings.patchEmbedding({ endpoint: 'https://user:secret@example.com/v1/', model: 'fixture-embed' })
    settings.setEmbeddingDim('4')
    settings.embeddingKey = 'sk-test'
    await settings.save()
    await settle(vault)
    expect(vault.phase).toBe('ready')
    expect(vault.indexWork).toBe('idle')
    expect(embeddingClient.calls).toBeGreaterThan(0)
    expect(settings.form.embedding.endpoint).toBe('https://user:secret@example.com/v1/')
    embeddingClient.calls = 0
    fetchMock.mockClear()
    await vault.openClonedVault(fs)
    await settle(vault)
    expect(embeddingClient.calls).toBe(0)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(vault.indexPhase).toBe('ready')
    vault.updateDoc({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'edited-body' }] }],
    })
    await vault.flush()
    expect(embeddingClient.calls).toBe(1)
    expect(await fs.stat('.stride/search/v1/snapshots/1.vane')).toBeNull()
  })

  it('aborts a hung embed so the next vault open finishes', async () => {
    useMemoryFixture()
    setSecretsStore(new MemorySecretsStore())
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (!url.includes('/embeddings')) {
        return Promise.resolve(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }))
      }
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal
        const fail = () => reject(new DOMException('The operation was aborted.', 'AbortError'))
        if (!signal) return
        if (signal.aborted) {
          fail()
          return
        }
        signal.addEventListener('abort', fail, { once: true })
      })
    })
    vi.stubGlobal('fetch', fetchMock)
    registerVault()
    const vault = resolve(VaultService)
    const settings = resolve(SettingsService)
    const fs = new MemoryFileSystem('cancel-vault')
    await vault.openClonedVault(fs)
    await vault.createNote()
    settings.patchEmbedding({ endpoint: 'https://user:secret@example.com/v1/', model: 'fixture-embed' })
    settings.setEmbeddingDim('4')
    settings.embeddingKey = 'sk-test'
    const saving = settings.save()
    for (let attempt = 0; attempt < 100 && !fetchMock.mock.calls.some((call) => String(call[0]).includes('/embeddings')); attempt += 1) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10))
    }
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes('/embeddings'))).toBe(true)
    const opened = Promise.race([
      vault.openClonedVault(new MemoryFileSystem('cancel-vault-next')).then(() => 'opened' as const),
      new Promise<'hung'>((resolvePromise) => {
        setTimeout(() => resolvePromise('hung'), 4000)
      }),
    ])
    await expect(opened).resolves.toBe('opened')
    expect(vault.error).toBe('')
    await saving
  }, 10_000)

  it('embeds identical note text once', async () => {
    useMemoryFixture()
    setSecretsStore(new MemorySecretsStore())
    const fetchMock = embedFetch([[1, 0, 0, 0]])
    vi.stubGlobal('fetch', fetchMock)
    registerVault()
    const vault = resolve(VaultService)
    const settings = resolve(SettingsService)
    await vault.openClonedVault(new MemoryFileSystem('dedupe-vault'))
    await vault.createNote()
    await vault.createNote()
    settings.patchEmbedding({ endpoint: 'http://127.0.0.1/v1', model: 'fixture-embed' })
    settings.setEmbeddingDim('4')
    settings.embeddingKey = 'sk-test'
    embeddingClient.calls = 0
    await settings.save()
    await settle(vault)
    expect(embeddingClient.calls).toBe(1)
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { input?: string[] }
    expect(body.input).toHaveLength(1)
  })

  it('keeps a ready text search while document embeds are failing', async () => {
    useMemoryFixture()
    setSecretsStore(new MemorySecretsStore())
    const fetchMock = embedFetch('fail')
    vi.stubGlobal('fetch', fetchMock)
    registerVault()
    const vault = resolve(VaultService)
    const settings = resolve(SettingsService)
    const fs = new MemoryFileSystem('gap-vault')
    await vault.openClonedVault(fs)
    await vault.createNote()
    vault.updateDoc({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'zephyrword' }] }],
    })
    await vault.flush()
    settings.patchEmbedding({ endpoint: 'http://127.0.0.1/v1', model: 'fixture-embed' })
    settings.setEmbeddingDim('4')
    settings.embeddingKey = 'sk-test'
    await settings.save()
    await settle(vault)
    expect(vault.phase).toBe('ready')
    expect(vault.indexPhase).toBe('ready')
    expect(vault.indexWork).toBe('embedding')
    expect(vault.searchDegraded).toBe(true)
    fetchMock.mockImplementation(embedFetch([[1, 0, 0, 0]]).getMockImplementation()!)
    fetchMock.mockClear()
    await vault.queryRanked('zephyrword')
    vault.searchQuery = 'zephyrword'
    await vault.runSearch()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(vault.searchMode).toBe('text')
    expect(vault.searchDegraded).toBe(true)
    expect(vault.indexWork).toBe('embedding')
    fetchMock.mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { input?: string[] }
      const input = body.input ?? []
      return new Response(JSON.stringify({
        data: input.map((_text, index) => ({ index, embedding: [1, 0, 0, 0] })),
      }), { status: 200 })
    })
    vault.retryMisses()
    await settle(vault)
    for (let attempt = 0; attempt < 20 && vault.indexWork !== 'idle'; attempt += 1) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 0))
    }
    expect(vault.indexWork).toBe('idle')
    expect(vault.searchDegraded).toBe(false)
    expect(vault.indexPhase).toBe('ready')
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => {
      root.render(<StatusBar />)
    })
    const status = host.querySelector('[data-testid="index-status"]')
    expect(status?.textContent).toBe('Index ready')
    expect(status?.tagName).toBe('SPAN')
    root.unmount()
    host.remove()
    expect(await fs.stat('.stride/search')).not.toBeNull()
  })

  it('does not write a cache for a broad vault', async () => {
    useMemoryFixture()
    registerVault()
    const vault = resolve(VaultService)
    const fs = new MemoryFileSystem('/tmp/Downloads')
    await vault.openClonedVault(fs)
    await vault.createNote()
    await vault.flush()
    expect(await fs.stat('.stride/search')).toBeNull()
    expect(vault.phase).toBe('ready')
  })

  it('keeps the cache slot off the service proxy', async () => {
    useMemoryFixture()
    registerVault()
    const vault = resolve(VaultService)
    expect(isObservable(searchSlot(vault))).toBe(false)
    let renders = 0
    const View = observer(function View() {
      const current = useService(VaultService)
      renders += 1
      return <output>{current.indexPhase}</output>
    })
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => {
      root.render(<View />)
    })
    const seen = renders
    const slot = searchSlot(vault)
    for (let index = 0; index < 10_000; index += 1) {
      slot.queries.push({ key: `sig\n${index}`, vector: [index, 0, 0, 0] })
    }
    await act(async () => {
      await Promise.resolve()
    })
    expect(renders).toBe(seen)
    root.unmount()
    host.remove()
  })

  it('pours when a snapshot is damaged and builds hot-restore docs without zeroing a missing record', () => {
    const previous = '11'.repeat(32)
    const next = '22'.repeat(32)
    const stable = '33'.repeat(32)
    const missing = '44'.repeat(32)
    const notes: CacheNote[] = [
      { id: 'edited', text: 'new text', contentHash: next },
      { id: 'stable', text: 'same text', contentHash: stable },
      { id: 'gap', text: 'same text', contentHash: missing },
    ]
    const baseline: BaselineNote[] = [
      { id: 'edited', contentHash: previous },
      { id: 'stable', contentHash: stable },
      { id: 'gap', contentHash: missing },
    ]
    const have = new Set([next, stable])
    const plan = planSync(notes, baseline, (hash) => have.has(hash), true)
    expect(plan.unchanged).toEqual(['stable'])
    expect(plan.embed.map((note) => note.id)).toEqual(['gap'])
    expect(plan.cached.map((note) => note.id)).toEqual(['edited'])
    const vectors = new Map<string, number[]>([
      [previous, [1, 0, 0, 0]],
      [next, [0, 2, 0, 0]],
      [stable, [0, 0, 3, 0]],
    ])
    const restored = docsForRebuild(true, plan, notes, (hash) => vectors.get(hash) ?? null, baseline)
    expect(restored.map((doc) => doc.id)).toEqual(['edited'])
    expect(restored[0]).toEqual({ id: 'edited', text: 'new text', vector: [0, 2, 0, 0] })
    expect(restored.some((doc) => doc.id === 'gap' || doc.id === 'stable')).toBe(false)
    const poured = docsForRebuild(false, plan, notes, (hash) => vectors.get(hash) ?? null, baseline)
    expect(poured.map((doc) => doc.id).sort()).toEqual(['edited', 'gap', 'stable'])
    expect(poured.find((doc) => doc.id === 'gap')?.vector).toBeUndefined()
  })
})
