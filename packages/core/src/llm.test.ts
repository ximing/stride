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

const responsesSse = [
  'event: response.created',
  'data: {"type":"response.created","response":{"id":"resp_x","object":"response","status":"in_progress","output":[]}}',
  '',
  'event: response.output_item.added',
  'data: {"type":"response.output_item.added","output_index":0,"item":{"id":"msg_x","type":"message","role":"assistant","status":"in_progress","content":[]}}',
  '',
  'event: response.content_part.added',
  'data: {"type":"response.content_part.added","output_index":0,"content_index":0,"item_id":"msg_x","part":{"type":"output_text","text":""}}',
  '',
  'event: response.output_text.delta',
  'data: {"type":"response.output_text.delta","output_index":0,"content_index":0,"item_id":"msg_x","delta":"pong"}',
  '',
  'event: response.output_text.done',
  'data: {"type":"response.output_text.done","output_index":0,"content_index":0,"item_id":"msg_x","text":"pong"}',
  '',
  'event: response.content_part.done',
  'data: {"type":"response.content_part.done","output_index":0,"content_index":0,"item_id":"msg_x","part":{"type":"output_text","text":"pong"}}',
  '',
  'event: response.output_item.done',
  'data: {"type":"response.output_item.done","output_index":0,"item":{"id":"msg_x","type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":"pong"}]}}',
  '',
  'event: response.completed',
  'data: {"type":"response.completed","response":{"id":"resp_x","object":"response","status":"completed","output":[{"id":"msg_x","type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":"pong"}]}],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}',
  '',
].join('\n')

function responsesSseResponse(): Response {
  return new Response(responsesSse, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

const anthropicSse = [
  'event: message_start',
  'data: {"type":"message_start","message":{"id":"msg_x","type":"message","role":"assistant","content":[],"model":"claude-haiku-5-5","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}',
  '',
  'event: content_block_start',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"pong"}}',
  '',
  'event: content_block_stop',
  'data: {"type":"content_block_stop","index":0}',
  '',
  'event: message_delta',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}',
  '',
  'event: message_stop',
  'data: {"type":"message_stop"}',
  '',
].join('\n')

function anthropicSseResponse(): Response {
  return new Response(anthropicSse, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  if (typeof Request !== 'undefined' && input instanceof Request) return input.url
  return String(input)
}

function authorizationOf(input: RequestInfo | URL, init?: RequestInit): string {
  const fromInit = new Headers(init?.headers).get('authorization') || ''
  if (fromInit) return fromInit
  if (typeof Request !== 'undefined' && input instanceof Request) return input.headers.get('authorization') || ''
  return ''
}

const RESPONSES_PROVIDERS = new Set(['openai', 'xai', 'zhipu'])

describe('llm catalog', () => {
  it('pins each provider to its official API kind, host, and current default model', () => {
    expect(llmApi('claude')).toBe('anthropic-messages')
    expect(catalogBaseUrl('claude')).toBe('https://api.anthropic.com')
    expect(catalogDefaultModel('claude')).toBe('claude-haiku-5-5')
    expect(llmApi('openai')).toBe('openai-responses')
    expect(llmApi('xai')).toBe('openai-responses')
    expect(llmApi('zhipu')).toBe('openai-responses')
    expect(catalogBaseUrl('zhipu')).toBe('https://open.bigmodel.cn/api/v1')
    expect(catalogDefaultModel('zhipu')).toBe('glm-5.3-flash')
    for (const provider of LLM_PROVIDERS) {
      if (provider.id === 'claude') expect(llmApi(provider.id)).toBe('anthropic-messages')
      else if (RESPONSES_PROVIDERS.has(provider.id)) expect(llmApi(provider.id)).toBe('openai-responses')
      else expect(llmApi(provider.id)).toBe('openai-completions')
      expect(catalogBaseUrl(provider.id)).toBe(provider.baseUrl)
      expect(catalogDefaultModel(provider.id)).toBe(provider.defaultModel)
    }
    expect(isLlmProvider('openai')).toBe(true)
    expect(isLlmProvider('custom')).toBe(true)
    expect(isLlmProvider('fixture')).toBe(false)
    expect(LLM_PROVIDERS.find((provider) => provider.id === 'gemini')?.suggestions).toEqual([
      'gemini-3.8-flash',
      'gemini-3.6-flash',
      'gemini-3.5-flash-lite',
    ])
    expect(catalogDefaultModel('openai')).toBe('gpt-6-luna')
    expect(catalogDefaultModel('minimax')).toBe('MiniMax-M3.1-Flash')
    expect(catalogBaseUrl('minimax')).toBe('https://api.minimax.cn/v1')
    expect(catalogDefaultModel('groq')).toBe('llama-3.1-8b-instant')
    expect(catalogDefaultModel('dashscope')).toBe('qwen3.8-flash')
    expect(LLM_PROVIDERS.find((provider) => provider.id === 'xai')?.label).toBe('Grok')
    expect(LLM_PROVIDERS.find((provider) => provider.id === 'deepseek')?.suggestions).toEqual([
      'deepseek-flash',
      'deepseek-v4-pro',
    ])
    expect(LLM_PROVIDERS.find((provider) => provider.id === 'zhipu')?.label).toBe('智谱')
    expect(LLM_PROVIDERS.find((provider) => provider.id === 'zhipu')?.suggestions).toEqual([
      'glm-5.3-flash',
      'glm-5.3-flashx',
      'glm-5.3',
    ])
    expect(LLM_PROVIDERS.find((provider) => provider.id === 'kimi')?.suggestions).toEqual([
      'kimi-k3.1-pro-highspeed',
      'kimi-k3.1-pro',
      'kimi-k3',
    ])
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
      return responsesSseResponse()
    })
    const result = await testLlmConnection(current, { fetch: fetchMock, baseUrl: 'https://override.example/v1' })
    expect(result).toEqual({ ok: true })
    expect(seen).toContain('https://override.example/v1/responses')
    expect(authorization).toContain('sk-override-key')
  })

  it('sets kimi compat and leaves other openai models on the shared limits', () => {
    const kimi = resolveLlm(config({
      provider: 'kimi',
      model: 'kimi-k3.1-pro-highspeed',
      baseUrl: '',
      apiKey: 'sk-kimi',
    }))
    expect(kimi.model.baseUrl).toBe('https://api.moonshot.cn/v1')
    expect(kimi.model.api).toBe('openai-completions')
    expect(kimi.model.reasoning).toBe(true)
    expect(kimi.model.thinkingLevelMap).toMatchObject({ off: 'low', low: 'low', high: 'high', max: 'max' })
    expect(kimi.model.compat).toMatchObject({
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: true,
      supportsUsageInStreaming: true,
      maxTokensField: 'max_completion_tokens',
      thinkingFormat: 'openai',
      requiresReasoningContentOnAssistantMessages: true,
      supportsStrictMode: false,
    })
    const deepseek = resolveLlm(config({
      provider: 'deepseek',
      model: 'deepseek-flash',
      baseUrl: '',
      apiKey: 'sk-deepseek',
    }))
    expect(deepseek.model.api).toBe('openai-completions')
    expect(deepseek.model.baseUrl).toBe('https://api.deepseek.com')
    expect(deepseek.model.reasoning).toBe(true)
    expect(deepseek.model.compat).toMatchObject({
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      maxTokensField: 'max_tokens',
      thinkingFormat: 'deepseek',
      requiresReasoningContentOnAssistantMessages: true,
      supportsStrictMode: false,
    })
    const openai = resolveLlm(config())
    expect(openai.model.api).toBe('openai-responses')
    expect(openai.model.contextWindow).toBe(128_000)
    expect(openai.model.maxTokens).toBe(4_096)
    expect(openai.model.input).toEqual(['text'])
    expect(openai.model.reasoning).toBe(true)
    expect(openai.model.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
    expect(openai.model.thinkingLevelMap).toMatchObject({ off: 'none', low: 'low', max: 'max' })
    expect(openai.model.compat).toMatchObject({
      supportsDeveloperRole: true,
      supportsLongCacheRetention: true,
      supportsExplicitPromptCacheMode: true,
    })
    const claude = resolveLlm(config({ provider: 'claude', model: 'claude-sonnet-4-5', baseUrl: '', apiKey: 'sk-claude' }))
    expect(claude.model.api).toBe('anthropic-messages')
    expect(claude.model.provider).toBe('claude')
    expect(claude.model.baseUrl).toBe('https://api.anthropic.com')
    expect(claude.model.id).toBe('claude-sonnet-4-5')
    expect(claude.model.reasoning).toBe(true)
    expect(claude.model.thinkingLevelMap).toMatchObject({ off: null, low: 'low', max: 'max' })
    expect(claude.model.compat).toMatchObject({
      forceAdaptiveThinking: true,
      supportsTemperature: false,
    })

    const zhipu = resolveLlm(config({
      provider: 'zhipu',
      model: 'glm-5.3',
      baseUrl: '',
      apiKey: 'sk-zhipu',
    }))
    expect(zhipu.model.api).toBe('openai-responses')
    expect(zhipu.model.baseUrl).toBe('https://open.bigmodel.cn/api/v1')
    expect(zhipu.model.reasoning).toBe(true)
    expect(zhipu.model.maxTokens).toBe(8_192)
    expect(zhipu.model.thinkingLevelMap).toMatchObject({ off: 'low', low: 'low', high: 'high', max: 'max' })
    expect(zhipu.model.compat).toMatchObject({
      supportsDeveloperRole: false,
      supportsLongCacheRetention: false,
      supportsStrictMode: false,
    })
    expect(effectiveBaseUrl({ provider: 'zhipu', baseUrl: 'https://open.bigmodel.cn/api/paas/v4/' })).toBe(
      'https://open.bigmodel.cn/api/v1',
    )

    const minimax = resolveLlm(config({
      provider: 'minimax',
      model: 'MiniMax-M3.1-Flash',
      baseUrl: '',
      apiKey: 'sk-minimax',
    }))
    expect(minimax.model.api).toBe('openai-completions')
    expect(minimax.model.baseUrl).toBe('https://api.minimax.cn/v1')
    expect(minimax.model.reasoning).toBe(true)
    expect(minimax.model.thinkingLevelMap).toMatchObject({ off: 'low', low: 'low', max: 'max' })
    expect(minimax.model.compat).toMatchObject({
      supportsReasoningEffort: true,
      maxTokensField: 'max_completion_tokens',
      thinkingFormat: 'openai',
    })
    expect(effectiveBaseUrl({ provider: 'minimax', baseUrl: 'https://api.minimaxi.com/v1/' })).toBe(
      'https://api.minimax.cn/v1',
    )
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
      return responsesSseResponse()
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

  it('calls the Zhipu responses endpoint from the catalog base URL', async () => {
    let seen = ''
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      seen = requestUrl(input)
      expect(authorizationOf(input, init)).toContain('sk-zhipu')
      return responsesSseResponse()
    })
    const result = await testLlmConnection(config({
      provider: 'zhipu',
      model: 'glm-5.3',
      baseUrl: '',
      apiKey: 'sk-zhipu',
    }), { fetch: fetchMock })
    expect(result).toEqual({ ok: true })
    expect(seen).toContain('https://open.bigmodel.cn/api/v1/responses')
    expect(seen).not.toContain('/chat/completions')
  })

  it('calls the DeepSeek chat completions endpoint and disables thinking', async () => {
    let seen = ''
    let body = ''
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      seen = requestUrl(input)
      body = typeof init?.body === 'string' ? init.body : ''
      expect(authorizationOf(input, init)).toContain('sk-deepseek')
      return sseResponse()
    })
    const result = await testLlmConnection(config({
      provider: 'deepseek',
      model: 'deepseek-flash',
      baseUrl: '',
      apiKey: 'sk-deepseek',
    }), { fetch: fetchMock })
    expect(result).toEqual({ ok: true })
    expect(seen).toContain('https://api.deepseek.com/chat/completions')
    expect(JSON.parse(body)).toMatchObject({
      model: 'deepseek-flash',
      thinking: { type: 'disabled' },
    })
  })

  it('calls Kimi chat completions with low reasoning effort and max_completion_tokens', async () => {
    let seen = ''
    let body = ''
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      seen = requestUrl(input)
      body = typeof init?.body === 'string' ? init.body : ''
      expect(authorizationOf(input, init)).toContain('sk-kimi')
      return sseResponse()
    })
    const result = await testLlmConnection(config({
      provider: 'kimi',
      model: 'kimi-k3.1-pro-highspeed',
      baseUrl: '',
      apiKey: 'sk-kimi',
    }), { fetch: fetchMock })
    expect(result).toEqual({ ok: true })
    expect(seen).toContain('https://api.moonshot.cn/v1/chat/completions')
    expect(JSON.parse(body)).toMatchObject({
      model: 'kimi-k3.1-pro-highspeed',
      reasoning_effort: 'low',
      max_completion_tokens: 16,
    })
    expect(JSON.parse(body).thinking).toBeUndefined()
  })

  it('calls MiniMax chat completions on the current CN host with low reasoning effort', async () => {
    let seen = ''
    let body = ''
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      seen = requestUrl(input)
      body = typeof init?.body === 'string' ? init.body : ''
      expect(authorizationOf(input, init)).toContain('sk-minimax')
      return sseResponse()
    })
    const result = await testLlmConnection(config({
      provider: 'minimax',
      model: 'MiniMax-M3.1-Flash',
      baseUrl: '',
      apiKey: 'sk-minimax',
    }), { fetch: fetchMock })
    expect(result).toEqual({ ok: true })
    expect(seen).toContain('https://api.minimax.cn/v1/chat/completions')
    expect(JSON.parse(body)).toMatchObject({
      model: 'MiniMax-M3.1-Flash',
      reasoning_effort: 'low',
      max_completion_tokens: 16,
    })
    expect(JSON.parse(body).store).toBeUndefined()
  })

  it('sends each remaining provider the official request fields', async () => {
    async function capture(
      partial: Partial<LlmConfig>,
      response: () => Response,
    ): Promise<{ url: string; body: Record<string, unknown> }> {
      let url = ''
      let raw = ''
      const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        url = requestUrl(input)
        raw = typeof init?.body === 'string' ? init.body : ''
        return response()
      })
      const result = await testLlmConnection(config(partial), { fetch: fetchMock })
      expect(result).toEqual({ ok: true })
      return { url, body: raw ? JSON.parse(raw) as Record<string, unknown> : {} }
    }

    const openai = await capture({
      provider: 'openai',
      model: 'gpt-6-luna',
      baseUrl: '',
      apiKey: 'sk-openai',
    }, responsesSseResponse)
    expect(openai.url).toContain('https://api.openai.com/v1/responses')
    expect(openai.body).toMatchObject({
      model: 'gpt-6-luna',
      store: false,
      max_output_tokens: 16,
      reasoning: { effort: 'none' },
    })
    expect(openai.body.input).toBeDefined()
    expect(openai.body.messages).toBeUndefined()
    expect(openai.body.max_tokens).toBeUndefined()
    expect(openai.body.max_completion_tokens).toBeUndefined()

    const xai = await capture({
      provider: 'xai',
      model: 'grok-4.7',
      baseUrl: '',
      apiKey: 'sk-xai',
    }, responsesSseResponse)
    expect(xai.url).toContain('https://api.x.ai/v1/responses')
    expect(xai.body).toMatchObject({
      model: 'grok-4.7',
      store: false,
      max_output_tokens: 16,
      reasoning: { effort: 'low' },
    })
    expect(xai.body.include).toEqual(['reasoning.encrypted_content'])
    expect(xai.body.messages).toBeUndefined()

    const gemini = await capture({
      provider: 'gemini',
      model: 'gemini-3.8-flash',
      baseUrl: '',
      apiKey: 'sk-gemini',
    }, sseResponse)
    expect(gemini.url).toContain('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions')
    expect(gemini.body).toMatchObject({
      model: 'gemini-3.8-flash',
      reasoning_effort: 'low',
      max_completion_tokens: 16,
    })
    expect(gemini.body.store).toBeUndefined()
    expect(gemini.body.max_tokens).toBeUndefined()
    expect(gemini.body.thinking).toBeUndefined()
    expect(gemini.body.enable_thinking).toBeUndefined()

    const dashscope = await capture({
      provider: 'dashscope',
      model: 'qwen3.8-flash',
      baseUrl: '',
      apiKey: 'sk-dashscope',
    }, sseResponse)
    expect(dashscope.url).toContain('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions')
    expect(dashscope.body).toMatchObject({
      model: 'qwen3.8-flash',
      reasoning_effort: 'none',
      max_completion_tokens: 16,
    })
    expect(dashscope.body.store).toBeUndefined()
    expect(dashscope.body.enable_thinking).toBeUndefined()
    expect(dashscope.body.thinking_budget).toBeUndefined()
    expect(dashscope.body.max_tokens).toBeUndefined()

    const doubao = await capture({
      provider: 'doubao',
      model: 'doubao-seed-2-1-lite-260915',
      baseUrl: '',
      apiKey: 'sk-doubao',
    }, sseResponse)
    expect(doubao.url).toContain('https://ark.cn-beijing.volces.com/api/v3/chat/completions')
    expect(doubao.body).toMatchObject({
      model: 'doubao-seed-2-1-lite-260915',
      thinking: { type: 'disabled' },
      max_tokens: 16,
    })
    expect(doubao.body.store).toBeUndefined()
    expect(doubao.body.reasoning_effort).toBeUndefined()
    expect(doubao.body.max_completion_tokens).toBeUndefined()

    const groq = await capture({
      provider: 'groq',
      model: 'llama-3.1-8b-instant',
      baseUrl: '',
      apiKey: 'sk-groq',
    }, sseResponse)
    expect(groq.url).toContain('https://api.groq.com/openai/v1/chat/completions')
    expect(groq.body).toMatchObject({
      model: 'llama-3.1-8b-instant',
      max_completion_tokens: 16,
    })
    expect(groq.body.store).toBeUndefined()
    expect(groq.body.reasoning_effort).toBeUndefined()
    expect(groq.body.max_tokens).toBeUndefined()

    const openrouter = await capture({
      provider: 'openrouter',
      model: 'google/gemini-3.8-flash',
      baseUrl: '',
      apiKey: 'sk-openrouter',
    }, sseResponse)
    expect(openrouter.url).toContain('https://openrouter.ai/api/v1/chat/completions')
    expect(openrouter.body).toMatchObject({
      model: 'google/gemini-3.8-flash',
      reasoning: { effort: 'low' },
      max_completion_tokens: 16,
    })
    expect(openrouter.body.store).toBeUndefined()
    expect(openrouter.body.reasoning_effort).toBeUndefined()

    const mistral = await capture({
      provider: 'mistral',
      model: 'mistral-small-latest',
      baseUrl: '',
      apiKey: 'sk-mistral',
    }, sseResponse)
    expect(mistral.url).toContain('https://api.mistral.ai/v1/chat/completions')
    expect(mistral.body).toMatchObject({
      model: 'mistral-small-latest',
      max_tokens: 16,
    })
    expect(mistral.body.store).toBeUndefined()
    expect(mistral.body.reasoning_effort).toBeUndefined()
    expect(mistral.body.max_completion_tokens).toBeUndefined()

    const claude = await capture({
      provider: 'claude',
      model: 'claude-haiku-5-5',
      baseUrl: '',
      apiKey: 'sk-claude',
    }, anthropicSseResponse)
    expect(claude.url).toContain('https://api.anthropic.com')
    expect(claude.body).toMatchObject({
      model: 'claude-haiku-5-5',
      max_tokens: 16,
    })
    expect(claude.body.thinking).toBeUndefined()
    expect(claude.body.output_config).toBeUndefined()
  })
})
