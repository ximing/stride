import { has, register, resolve } from '@rabjs/react'
import { emptyTokenHistory, localDateKey, serializeTokenUsage } from '@stride/core'
import { MemoryFileSystem, MemorySecretsStore } from '@stride/platform'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resetSecretsStore, setSecretsStore, SETTINGS_STORAGE_KEY, SettingsService, TOKEN_USAGE_STORAGE_KEY } from './settings.service'

function resetSettingsMemory() {
  const settings = resolve(SettingsService)
  settings.form = {
    embedding: { endpoint: '', model: '', keyMask: '', dim: 4 },
    llmConfigs: [],
    releasesUrl: '',
    gitEnabled: true,
    autoSyncMinutes: 0,
    autoGitEnabled: false,
    autoGitIdleSeconds: 0,
    autoGitBlurSeconds: 0,
    appearance: { noteWidth: 'standard', fontSize: 15 },
    editor: { autosaveDebounceMs: 350 },
    updates: { channel: 'stable', autoCheck: true },
    privacy: { telemetryEnabled: false },
  }
  settings.setEmbeddingDim('4')
  settings.embeddingKey = ''
  settings.llmKeyDrafts = {}
  settings.selectedLlmId = ''
  settings.embeddingTestResult = ''
  settings.llmTestResult = ''
  settings.notice = ''
  settings.tokenHistory = emptyTokenHistory()
  settings.usageVaultOpen = false
  Object.assign(settings, {
    memoryEmbeddingKey: '',
    memoryLlmKeys: {},
    loaded: false,
    loadTask: null,
    usageFs: null,
    usageChain: Promise.resolve(),
    usageEpoch: (settings as unknown as { usageEpoch: number }).usageEpoch + 1,
    pendingUsage: [],
  })
  localStorage.removeItem(TOKEN_USAGE_STORAGE_KEY)
}

describe('settings service', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    localStorage.removeItem(SETTINGS_STORAGE_KEY)
    localStorage.removeItem(TOKEN_USAGE_STORAGE_KEY)
    if (has(SettingsService)) resetSettingsMemory()
    resetSecretsStore()
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
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
      data: [{ index: 0, embedding: [1, 0, 0, 0] }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    register(SettingsService)
    const settings = resolve(SettingsService)
    settings.patchEmbedding({ endpoint: 'http://127.0.0.1/v1', model: 'fixture-embed' })
    settings.setEmbeddingDim('4')
    settings.embeddingKey = 'sk-stride-embed-test-key'
    await settings.testEmbedding()
    expect(settings.embeddingTestResult).toBe('ok')
    expect(localStorage.getItem(SETTINGS_STORAGE_KEY)).toBeNull()
    const init = fetchMock.mock.calls[0]?.[1]
    expect(JSON.parse(String(init?.body)).input).toEqual(['connection test'])

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
    expect(settings.embeddingTestResult).toContain('dim:')

    const calls = fetchMock.mock.calls.length
    settings.setEmbeddingDim('')
    await settings.testEmbedding()
    expect(settings.embeddingTestResult).toBe('dim')
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
    expect(settings.llmRuntime(first)?.provider).toBe('openai')
    expect(settings.llmRuntime(first)?.apiKey).toBe('sk-stride-llm-alpha-key')
    expect(settings.llmRuntime('missing')?.provider).toBe('deepseek')

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
    expect(settings.llmTestResult).toBe('ok')
    expect(fetchMock).toHaveBeenCalled()
    expect(settings.tokenHistory.days).toEqual([])
    expect(localStorage.getItem(TOKEN_USAGE_STORAGE_KEY)).toBeNull()
  })

  it('writes dated token usage into the vault and reloads it by week', async () => {
    register(SettingsService)
    const settings = resolve(SettingsService)
    const fs = new MemoryFileSystem('vault')
    const today = localDateKey()
    await settings.bindUsageVault(fs)
    settings.recordTokenUsage({
      model: 'gpt-4o-mini',
      input: 3,
      output: 2,
      cacheRead: 1,
      cacheWrite: 0,
      total: 4,
    })
    settings.recordTokenUsage({
      model: ' gpt-4o-mini ',
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 4,
      total: 0,
    })
    settings.recordTokenUsage({
      model: 'deepseek-chat',
      input: 8,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      total: 10,
    })
    settings.recordTokenUsage({
      model: ' ',
      input: 9,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      total: 10,
    })
    await settings.whenTokenUsageSettled()
    const stored = await fs.readText('.stride/token-usage.json')
    expect(stored).toContain('gpt-4o-mini')
    expect(stored).toContain('deepseek-chat')
    expect(stored).toContain(today)
    expect(localStorage.getItem(SETTINGS_STORAGE_KEY)).toBeNull()
    expect(localStorage.getItem(TOKEN_USAGE_STORAGE_KEY)).toBeNull()
    settings.tokenHistory = emptyTokenHistory()
    await settings.bindUsageVault(fs)
    expect(settings.tokenHistory.days).toEqual([
      {
        date: today,
        model: 'deepseek-chat',
        input: 8,
        output: 2,
        cacheRead: 0,
        cacheWrite: 0,
        total: 10,
        requests: 1,
      },
      {
        date: today,
        model: 'gpt-4o-mini',
        input: 4,
        output: 3,
        cacheRead: 1,
        cacheWrite: 4,
        total: 12,
        requests: 2,
      },
    ])
  })

  it('folds device usage into the open vault once', async () => {
    register(SettingsService)
    const settings = resolve(SettingsService)
    localStorage.setItem(TOKEN_USAGE_STORAGE_KEY, serializeTokenUsage({
      models: [{
        model: 'gpt-4o-mini',
        input: 3,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        total: 4,
        requests: 2,
      }],
    }))
    const first = new MemoryFileSystem('first')
    await settings.bindUsageVault(first)
    expect(localStorage.getItem(TOKEN_USAGE_STORAGE_KEY)).toBeNull()
    expect(settings.tokenHistory.days).toEqual([{
      date: localDateKey(),
      model: 'gpt-4o-mini',
      input: 3,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      total: 4,
      requests: 2,
    }])
    const second = new MemoryFileSystem('second')
    await settings.bindUsageVault(second)
    expect(settings.tokenHistory.days).toEqual([])
    await expect(second.stat('.stride/token-usage.json')).resolves.toBeNull()
  })
})
