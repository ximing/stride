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
  settings.form = {
    embedding: { endpoint: '', model: '', keyMask: '', dim: 4 },
    llmConfigs: [],
    releasesUrl: '',
  }
  settings.setEmbeddingDim('4')
  settings.embeddingKey = ''
  settings.llmKeyDrafts = {}
  settings.selectedLlmId = ''
  settings.embeddingTestResult = ''
  settings.llmTestResult = ''
  settings.notice = ''
  Object.assign(settings, {
    memoryEmbeddingKey: '',
    memoryLlmKeys: {},
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

  it('saves two llm configs, switches the default, and refuses a plaintext key', async () => {
    const secrets = new MemorySecretsStore()
    setSecretsStore(secrets)
    register(SettingsService)
    const settings = resolve(SettingsService)
    settings.addLlmConfig()
    const first = settings.selectedLlmId
    settings.patchLlmConfig({ name: 'Primary' })
    settings.llmKeyDrafts = { [first]: 'sk-stride-llm-alpha-key' }
    settings.addLlmConfig()
    const second = settings.selectedLlmId
    expect(second).not.toBe(first)
    expect(settings.form.llmConfigs[0]?.isDefault).toBe(true)
    expect(settings.form.llmConfigs[1]?.isDefault).toBe(false)
    settings.patchLlmConfig({ name: 'Backup', provider: 'deepseek' })
    expect(settings.form.llmConfigs.find((config) => config.id === second)?.model).toBe('deepseek-chat')
    settings.llmKeyDrafts = { ...settings.llmKeyDrafts, [second]: 'sk-stride-llm-beta-key' }
    await settings.save()
    const stored = localStorage.getItem(SETTINGS_STORAGE_KEY) ?? ''
    expect(stored.includes('sk-stride-llm-alpha-key')).toBe(false)
    expect(stored.includes('sk-stride-llm-beta-key')).toBe(false)
    expect(stored.includes('"apiKey"')).toBe(false)
    expect(settings.notice).toBe('')
    expect(settings.llmKeyDrafts).toEqual({})
    await settings.load()
    expect(settings.form.llmConfigs).toHaveLength(2)
    expect(settings.llmRuntime()?.apiKey).toBe('sk-stride-llm-alpha-key')
    expect(settings.llmRuntime()?.provider).toBe('openai')

    settings.selectedLlmId = second
    settings.setDefaultLlmConfig()
    expect(settings.form.llmConfigs.find((config) => config.id === second)?.isDefault).toBe(true)
    expect(settings.form.llmConfigs.find((config) => config.id === first)?.isDefault).toBe(false)
    const masks = Object.fromEntries(settings.form.llmConfigs.map((config) => [config.id, config.keyMask]))
    settings.llmKeyDrafts = masks
    await settings.save()
    await settings.load()
    expect(settings.llmRuntime()?.provider).toBe('deepseek')
    expect(settings.llmRuntime()?.apiKey).toBe('sk-stride-llm-beta-key')
    expect(settings.llmRuntime()?.model).toBe('deepseek-chat')

    setSecretsStore({
      seal: async (value) => value,
      open: async (value) => value,
    })
    settings.selectedLlmId = first
    settings.llmKeyDrafts = { [first]: 'sk-plaintext-should-not-land' }
    await settings.save()
    expect(settings.notice).toContain('plaintext')
    expect(localStorage.getItem(SETTINGS_STORAGE_KEY) ?? '').not.toContain('sk-plaintext-should-not-land')
  })

  it('reports a successful llm probe from the selected config', async () => {
    const sse = [
      'data: {"id":"x","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"pong"},"finish_reason":null}]}',
      '',
      'data: {"id":"x","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n')
    const fetchMock = vi.fn(async () => new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } }))
    vi.stubGlobal('fetch', fetchMock)
    register(SettingsService)
    const settings = resolve(SettingsService)
    settings.addLlmConfig()
    settings.llmKeyDrafts = { [settings.selectedLlmId]: 'sk-stride-llm-test-key' }
    await settings.testSelectedLlm()
    expect(settings.llmTestResult).toBe('连接成功')
    expect(fetchMock).toHaveBeenCalled()
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
