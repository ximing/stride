import { has, observer, register, resolve, useService } from '@rabjs/react'
import { MemorySecretsStore } from '@stride/platform'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { UpdateBanner } from '../app'
import { GitService, resetSecretsStore, setSecretsStore, SETTINGS_STORAGE_KEY, SettingsService, UpdateService } from './panels.service'
import { VaultService } from './vault.service'

function resetSettingsMemory() {
  const settings = resolve(SettingsService)
  settings.patchEmbedding({ endpoint: '', model: '', keyMask: '', dim: 4 })
  settings.patchLlm({ provider: '', model: '', baseUrl: '', keyMask: '' })
  settings.setReleasesUrl('')
  settings.setEmbeddingDim('4')
  settings.embeddingKey = ''
  settings.llmKey = ''
  settings.embeddingTestResult = ''
  settings.notice = ''
  Object.assign(settings, {
    memoryEmbeddingKey: '',
    memoryLlmKey: '',
    loaded: false,
    loadTask: null,
  })
}

describe('browser panels', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    localStorage.removeItem(SETTINGS_STORAGE_KEY)
    if (has(SettingsService)) resetSettingsMemory()
    resetSecretsStore()
  })

  it('boots without calling the API and keeps updates idle', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    register(VaultService)
    register(SettingsService)
    register(UpdateService)
    register(GitService)
    await resolve(SettingsService).load()
    await resolve(SettingsService).save()
    const updates = resolve(UpdateService)
    await updates.check()
    await updates.download()
    await updates.confirm()
    await updates.dismiss()
    const git = resolve(GitService)
    expect(git.output).toBe('Git is not available in the browser')
    await git.refresh()
    await git.init()
    await git.commit()
    await git.pull()
    await git.push()
    await git.keepSide('note', 'ours')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(updates.phase).toBe('idle')
    expect(updates.error).toBe('')
    expect(git.output).toBe('Git is not available in the browser')
    expect(resolve(SettingsService).form.embedding.endpoint).toBe('')
    expect(resolve(SettingsService).notice).toBe('')
  })

  it('does not write the plaintext embedding key to localStorage', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const secrets = new MemorySecretsStore()
    setSecretsStore(secrets)
    register(SettingsService)
    const settings = resolve(SettingsService)
    const key = 'sk-stride-embed-test-key'
    settings.patchEmbedding({ endpoint: 'http://127.0.0.1/v1', model: 'fixture-embed' })
    settings.setEmbeddingDim('4')
    settings.embeddingKey = key
    await settings.save()
    const stored = localStorage.getItem(SETTINGS_STORAGE_KEY) ?? ''
    expect(stored.includes(key)).toBe(false)
    expect(stored.includes('keySeal')).toBe(true)
    expect(stored.includes('"apiKey"')).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(settings.embeddingKey).toBe('')
    expect(settings.form.embedding.keyMask).toBe('••••-key')
    expect(settings.notice).toBe('')

    settings.embeddingKey = 'plaintext-should-not-remain'
    await settings.load()
    expect(settings.embeddingKey).toBe('')
    expect(settings.embeddingRuntime().apiKey).toBe(key)
    expect(settings.form.embedding.keyMask).toBe('••••-key')
    expect(settings.embeddingRuntime().active).toBe(true)

    settings.embeddingKey = settings.form.embedding.keyMask
    settings.patchEmbedding({ model: 'fixture-embed-2' })
    await settings.save()
    expect((localStorage.getItem(SETTINGS_STORAGE_KEY) ?? '').includes(key)).toBe(false)
    expect(settings.embeddingRuntime().apiKey).toBe(key)
    expect(settings.embeddingRuntime().model).toBe('fixture-embed-2')

    settings.embeddingKey = ''
    await settings.save()
    expect(settings.embeddingRuntime().apiKey).toBe('')
    expect(settings.embeddingRuntime().intended).toBe(true)
    expect(settings.embeddingRuntime().active).toBe(false)
    expect((localStorage.getItem(SETTINGS_STORAGE_KEY) ?? '').includes(key)).toBe(false)

    settings.setEmbeddingDim('nope')
    await settings.save()
    await settings.load()
    expect(settings.embeddingDimText).toBe('')
    expect(settings.embeddingRuntime().dim).toBe(0)
    expect(settings.embeddingRuntime().intended).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reports the embedding probe without writing settings', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      data: [{ index: 0, embedding: [1, 0, 0, 0] }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    register(SettingsService)
    const settings = resolve(SettingsService)
    settings.patchEmbedding({ endpoint: 'http://127.0.0.1/v1', model: 'fixture-embed' })
    settings.setEmbeddingDim('4')
    settings.embeddingKey = 'sk-stride-embed-test-key'
    await settings.testEmbedding()
    expect(settings.embeddingTestResult).toBe('连接成功')
    expect(localStorage.getItem(SETTINGS_STORAGE_KEY)).toBeNull()
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit
    expect(JSON.parse(String(init.body)).input).toEqual(['连接测试'])

    fetchMock.mockResolvedValueOnce(new Response('no', { status: 401 }))
    await settings.testEmbedding()
    expect(settings.embeddingTestResult).toContain('401')

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    await settings.testEmbedding()
    expect(settings.embeddingTestResult).toContain('expected 1')

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      data: [{ index: 0, embedding: [1, 0] }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    await settings.testEmbedding()
    expect(settings.embeddingTestResult).toContain('维度不符')

    const calls = fetchMock.mock.calls.length
    settings.setEmbeddingDim('')
    await settings.testEmbedding()
    expect(settings.embeddingTestResult).toBe('维度不符')
    expect(fetchMock.mock.calls.length).toBe(calls)
  })

  it('hides the update banner while idle', async () => {
    register(UpdateService)
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const View = observer(function View() {
      useService(UpdateService)
      return <UpdateBanner />
    })
    await act(async () => {
      root.render(<View />)
    })
    expect(host.querySelector('[data-testid="update-banner"]')).toBeNull()
    root.unmount()
    host.remove()
  })
})
