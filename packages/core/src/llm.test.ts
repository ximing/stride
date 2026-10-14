import { describe, expect, it, vi } from 'vitest'
import {
  LLM_PROVIDERS,
  catalogBaseUrl,
  catalogDefaultModel,
  isLlmProvider,
  llmApi,
} from './llm-catalog.ts'
import {
  effectiveBaseUrl,
  llmProxyBaseUrl,
  redactSecret,
  resolveLlm,
  testLlmConnection,
  type LlmConfig,
} from './llm.ts'

function config(partial: Partial<LlmConfig> = {}): LlmConfig {
  return {
    id: 'c1',
    name: 'OpenAI',
    provider: 'openai',
    model: 'gpt-4o-mini',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-test-key',
    isDefault: true,
    ...partial,
  }
}

const sse = [
  'data: {"id":"x","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"pong"},"finish_reason":null}]}',
  '',
  'data: {"id":"x","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}',
  '',
  'data: [DONE]',
  '',
].join('\n')

function sseResponse(): Response {
  return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

function authorizationOf(input: RequestInfo | URL, init?: RequestInit): string {
  const fromInit = new Headers(init?.headers).get('authorization') || ''
  if (fromInit) return fromInit
  if (typeof Request !== 'undefined' && input instanceof Request) return input.headers.get('authorization') || ''
  return ''
}

describe('llm catalog', () => {
  it('uses anthropic messages for claude and openai completions for the rest', () => {
    expect(llmApi('claude')).toBe('anthropic-messages')
    expect(catalogBaseUrl('claude')).toBe('https://api.anthropic.com')
    expect(catalogDefaultModel('claude')).toBe('claude-sonnet-4-5')
    for (const provider of LLM_PROVIDERS) {
      if (provider.id === 'claude') continue
      expect(llmApi(provider.id)).toBe('openai-completions')
      expect(catalogBaseUrl(provider.id)).toBe(provider.baseUrl)
      expect(catalogDefaultModel(provider.id)).toBe(provider.defaultModel)
    }
    expect(isLlmProvider('openai')).toBe(true)
    expect(isLlmProvider('custom')).toBe(true)
    expect(isLlmProvider('fixture')).toBe(false)
    expect(LLM_PROVIDERS.find((provider) => provider.id === 'gemini')?.suggestions).toEqual([
      'gemini-2.5-flash',
      'gemini-2.5-pro',
      'gemini-3.8-flash',
    ])
    expect(LLM_PROVIDERS.find((provider) => provider.id === 'xai')?.label).toBe('Grok')
    expect(LLM_PROVIDERS.find((provider) => provider.id === 'zhipu')?.label).toBe('智谱')
    expect(catalogBaseUrl('custom')).toBe('')
    expect(catalogDefaultModel('custom')).toBe('')
  })
})

describe('llm connection', () => {
  it('fills an empty base URL from the catalog and lets a call override it', async () => {
    const current = config({ baseUrl: '', apiKey: 'sk-override-key' })
    expect(effectiveBaseUrl(current)).toBe('https://api.openai.com/v1')
    let seen = ''
    let authorization = ''
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      seen = String(input)
      authorization = authorizationOf(input, init)
      return sseResponse()
    })
    const result = await testLlmConnection(current, { fetch: fetchMock, baseUrl: 'https://override.example/v1' })
    expect(result).toEqual({ ok: true })
    expect(seen).toContain('https://override.example/v1/chat/completions')
    expect(authorization).toContain('sk-override-key')
  })

  it('sets kimi compat and leaves other openai models on the shared limits', () => {
    const kimi = resolveLlm(config({
      provider: 'kimi',
      model: 'kimi-k3',
      baseUrl: '',
      apiKey: 'sk-kimi',
    }))
    expect(kimi.model.baseUrl).toBe('https://api.moonshot.cn/v1')
    expect(kimi.model.compat).toMatchObject({
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      supportsUsageInStreaming: true,
      maxTokensField: 'max_tokens',
      supportsStrictMode: false,
    })
    const openai = resolveLlm(config())
    expect(openai.model.api).toBe('openai-completions')
    if (openai.model.api === 'openai-completions') {
      expect(openai.model.contextWindow).toBe(128_000)
      expect(openai.model.maxTokens).toBe(4_096)
      expect(openai.model.input).toEqual(['text'])
      expect(openai.model.reasoning).toBe(false)
      expect(openai.model.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
      expect(openai.model.compat?.supportsUsageInStreaming).not.toBe(true)
    }
    const claude = resolveLlm(config({ provider: 'claude', model: 'claude-sonnet-4-5', baseUrl: '', apiKey: 'sk-claude' }))
    expect(claude.model.api).toBe('anthropic-messages')
    expect(claude.model.provider).toBe('claude')
    expect(claude.model.baseUrl).toBe('https://api.anthropic.com')
    expect(claude.model.id).toBe('claude-sonnet-4-5')
  })

  it('rewrites http(s) base URLs onto the dev proxy and allows localhost', () => {
    expect(llmProxyBaseUrl('https://api.openai.com/v1')).toBe('/llm-proxy/https/api.openai.com/v1')
    expect(llmProxyBaseUrl('https://api.openai.com/v1/extra/path')).toBe('/llm-proxy/https/api.openai.com/v1/extra/path')
    expect(llmProxyBaseUrl('http://127.0.0.1/v1')).toBe('/llm-proxy/http/127.0.0.1/v1')
    expect(() => llmProxyBaseUrl('ftp://example.com/v1')).toThrow(/http/)
  })

  it('does not call fetch when the key is missing or the URL is not http', async () => {
    const missing = vi.fn()
    const missingKey = await testLlmConnection(config({ apiKey: '' }), { fetch: missing })
    expect(missingKey.ok).toBe(false)
    expect(missing).not.toHaveBeenCalled()
    const ftp = vi.fn()
    const blocked = await testLlmConnection(config({
      provider: 'custom',
      model: 'local',
      baseUrl: 'ftp://example.com/v1',
      apiKey: 'sk-secret',
    }), { fetch: ftp })
    expect(blocked.ok).toBe(false)
    expect(ftp).not.toHaveBeenCalled()
  })

  it('accepts a localhost base URL', async () => {
    const fetchMock = vi.fn(async () => sseResponse())
    const result = await testLlmConnection(config({
      provider: 'custom',
      model: 'local',
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKey: 'sk-local',
    }), { fetch: fetchMock })
    expect(result).toEqual({ ok: true })
    expect(fetchMock).toHaveBeenCalled()
  })

  it('accepts the verified SSE stream and redacts a rejected key', async () => {
    const key = 'sk-super-secret-value'
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(authorizationOf(input, init)).toContain(key)
      return sseResponse()
    })
    const ok = await testLlmConnection(config({ apiKey: key }), { fetch: fetchMock })
    expect(ok).toEqual({ ok: true })

    const denied = vi.fn(async () => new Response(JSON.stringify({ error: { message: `invalid api key ${key}` } }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    }))
    const failed = await testLlmConnection(config({ apiKey: key }), { fetch: denied })
    expect(failed.ok).toBe(false)
    if (!failed.ok) {
      expect(failed.error).not.toContain(key)
      expect(failed.error).toContain('••••')
    }
    expect(redactSecret(`invalid api key ${key}`, key)).toBe('invalid api key ••••')
  })
})
