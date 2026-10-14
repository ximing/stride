import {
  createModels,
  createProvider,
  type ApiKeyAuth,
  type Model,
} from '@earendil-works/pi-ai'
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic'
import { catalogBaseUrl, llmApi, llmProviderInfo } from './llm-catalog.ts'

export interface LlmConfig {
  id: string
  name: string
  provider: string
  model: string
  baseUrl: string
  apiKey: string
  isDefault: boolean
}

const KIMI_COMPAT = {
  supportsStore: false,
  supportsDeveloperRole: false,
  supportsReasoningEffort: false,
  supportsUsageInStreaming: true,
  maxTokensField: 'max_tokens' as const,
  supportsStrictMode: false,
}

export interface ResolvedLlm {
  models: ReturnType<typeof createModels>
  model: Model<'openai-completions'> | Model<'anthropic-messages'>
  apiKey: string
}

function passthroughApiKeyAuth(name: string): ApiKeyAuth {
  return {
    name,
    resolve: ({ credential }) =>
      Promise.resolve(credential?.key ? { auth: { apiKey: credential.key }, source: name } : undefined),
  }
}

export function effectiveBaseUrl(config: { provider: string; baseUrl: string }): string {
  const trimmed = config.baseUrl.trim()
  if (trimmed) return trimmed
  return catalogBaseUrl(config.provider)
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

export function llmProxyBaseUrl(baseUrl: string): string {
  let url: URL
  try {
    url = new URL(baseUrl)
  } catch {
    throw new Error('Base URL must use http or https')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Base URL must use http or https')
  }
  const scheme = url.protocol.slice(0, -1)
  return `/llm-proxy/${scheme}/${url.host}${url.pathname}${url.search}`
}

function openAiModel(config: LlmConfig, baseUrl: string): Model<'openai-completions'> {
  return {
    id: config.model,
    name: config.model,
    api: 'openai-completions',
    provider: config.provider,
    baseUrl,
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 4_096,
    ...(config.provider === 'kimi' ? { compat: KIMI_COMPAT } : {}),
  }
}

export function resolveLlm(config: LlmConfig): ResolvedLlm {
  const baseUrl = effectiveBaseUrl(config)
  const apiKey = config.apiKey
  const models = createModels()
  if (llmApi(config.provider) === 'anthropic-messages') {
    const template = anthropicProvider()
    const listed = template.getAllModels()
    const sample = listed.find((item) => item.id === config.model)
      ?? listed.find((item) => item.id === 'claude-sonnet-4-5')
      ?? listed[0]
    if (!sample) throw new Error('Claude provider has no model template')
    const model: Model<'anthropic-messages'> = {
      ...sample,
      id: config.model,
      name: config.model,
      provider: 'claude',
      baseUrl,
    }
    models.setProvider(createProvider({
      ...template,
      id: 'claude',
      name: 'Claude',
      baseUrl,
      api: anthropicMessagesApi(),
      models: [model],
    }))
    const resolved = models.getModel('claude', config.model)
    if (!resolved || !('api' in resolved) || resolved.api !== 'anthropic-messages') {
      throw new Error('pi-ai did not register the configured model')
    }
    return { models, model: resolved as Model<'anthropic-messages'>, apiKey }
  }
  const label = llmProviderInfo(config.provider)?.label ?? config.provider
  const model = openAiModel(config, baseUrl)
  models.setProvider(createProvider({
    id: config.provider,
    name: label,
    baseUrl,
    auth: { apiKey: passthroughApiKeyAuth(`${label} API key`) },
    models: [model],
    api: openAICompletionsApi(),
  }))
  const resolved = models.getModel(config.provider, config.model)
  if (!resolved || !('api' in resolved) || resolved.api !== 'openai-completions') {
    throw new Error('pi-ai did not register the configured model')
  }
  return { models, model: resolved as Model<'openai-completions'>, apiKey }
}

export function redactSecret(text: string, secret: string): string {
  if (!secret) return text
  return text.split(secret).join('••••')
}

export async function testLlmConnection(
  config: LlmConfig,
  options: { fetch?: typeof fetch; baseUrl?: string; signal?: AbortSignal } = {},
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!config.apiKey.trim()) return { ok: false, error: 'Missing API key' }
  if (!config.model.trim()) return { ok: false, error: 'Missing model' }
  const configured = effectiveBaseUrl(config)
  if (!isHttpUrl(configured)) return { ok: false, error: 'Base URL must use http or https' }
  const baseUrl = options.baseUrl ?? configured
  if (!isHttpUrl(baseUrl) && !baseUrl.startsWith('/llm-proxy/')) {
    return { ok: false, error: 'Base URL must use http or https' }
  }
  try {
    const resolved = resolveLlm({ ...config, baseUrl })
    const result = await resolved.models.completeSimple(resolved.model, {
      messages: [{ role: 'user', content: 'ping', timestamp: Date.now() }],
    }, {
      apiKey: config.apiKey,
      maxTokens: 16,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    })
    if (result.stopReason === 'error' || result.stopReason === 'aborted') {
      return { ok: false, error: redactSecret(result.errorMessage || `LLM request ${result.stopReason}`, config.apiKey) }
    }
    return { ok: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, error: redactSecret(message, config.apiKey) }
  }
}
