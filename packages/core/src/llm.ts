import {
  createModels,
  createProvider,
  type ApiKeyAuth,
  type Model,
} from '@earendil-works/pi-ai'
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy'
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

type CompletionsCompat = NonNullable<Model<'openai-completions'>['compat']>
type ResponsesCompat = NonNullable<Model<'openai-responses'>['compat']>
type AnthropicCompat = NonNullable<Model<'anthropic-messages'>['compat']>
type ThinkingMap = NonNullable<Model<'openai-completions'>['thinkingLevelMap']>

const NO_STORE: Pick<
  CompletionsCompat,
  'supportsStore' | 'supportsDeveloperRole' | 'supportsUsageInStreaming' | 'supportsStrictMode'
> = {
  supportsStore: false,
  supportsDeveloperRole: false,
  supportsUsageInStreaming: true,
  supportsStrictMode: false,
}

/** K3 / K3.1 always think; only low / high / max. */
const KIMI_THINKING = {
  off: 'low',
  minimal: 'low',
  low: 'low',
  medium: 'high',
  high: 'high',
  xhigh: 'max',
  max: 'max',
} as const satisfies ThinkingMap

const KIMI_COMPAT = {
  ...NO_STORE,
  supportsReasoningEffort: true,
  maxTokensField: 'max_completion_tokens',
  thinkingFormat: 'openai',
  requiresReasoningContentOnAssistantMessages: true,
} as const satisfies CompletionsCompat

const DEEPSEEK_COMPAT = {
  ...NO_STORE,
  supportsReasoningEffort: false,
  maxTokensField: 'max_tokens',
  thinkingFormat: 'deepseek',
  requiresReasoningContentOnAssistantMessages: true,
} as const satisfies CompletionsCompat

/** GLM-5.3 always thinks and only accepts low / high / max. */
const ZHIPU_THINKING = {
  off: 'low',
  minimal: 'low',
  low: 'low',
  medium: 'high',
  high: 'high',
  xhigh: 'max',
  max: 'max',
} as const satisfies ThinkingMap

/** GLM-5.3-Flash official Chat Completions: reasoning_effort only, never thinking.disabled. */
const ZHIPU_COMPAT = {
  ...NO_STORE,
  supportsReasoningEffort: true,
  maxTokensField: 'max_tokens',
  thinkingFormat: 'openai',
  requiresReasoningContentOnAssistantMessages: true,
} as const satisfies CompletionsCompat

const ZHIPU_RESPONSES = 'https://open.bigmodel.cn/api/v1'
const MINIMAX_LEGACY_COMPLETIONS = 'https://api.minimaxi.com/v1'

/** MiniMax-M3.1-Flash always thinks; only low / medium / high / xhigh / max. */
const MINIMAX_THINKING = {
  off: 'low',
  minimal: 'low',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
} as const satisfies ThinkingMap

const MINIMAX_COMPAT = {
  ...NO_STORE,
  supportsReasoningEffort: true,
  maxTokensField: 'max_completion_tokens',
  thinkingFormat: 'openai',
  requiresReasoningContentOnAssistantMessages: true,
} as const satisfies CompletionsCompat

/** GPT-6 Responses: reasoning.effort none / low / medium / high / xhigh / max. */
const OPENAI_THINKING = {
  off: 'none',
  minimal: null,
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
} as const satisfies ThinkingMap

const OPENAI_RESPONSES_COMPAT = {
  supportsDeveloperRole: true,
  supportsLongCacheRetention: true,
  supportsStrictMode: false,
  supportsExplicitPromptCacheMode: true,
} as const satisfies ResponsesCompat

/** grok-4.7 cannot disable thinking; official efforts are low / medium / high / xhigh. */
const XAI_THINKING = {
  off: 'low',
  minimal: null,
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: null,
} as const satisfies ThinkingMap

const XAI_RESPONSES_COMPAT = {
  supportsDeveloperRole: false,
  supportsLongCacheRetention: false,
  supportsStrictMode: false,
} as const satisfies ResponsesCompat

/** Gemini 3 cannot disable thinking; OpenAI-compat maps reasoning_effort to thinking_level. */
const GEMINI_THINKING = {
  off: 'low',
  minimal: 'low',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'high',
  max: 'high',
} as const satisfies ThinkingMap

const GEMINI_COMPAT = {
  ...NO_STORE,
  supportsReasoningEffort: true,
  maxTokensField: 'max_completion_tokens',
  thinkingFormat: 'openai',
  requiresReasoningContentOnAssistantMessages: true,
} as const satisfies CompletionsCompat

/** qwen3.8: reasoning_effort none disables thinking; high/max map to xhigh. Do not also send thinking_budget. */
const QWEN_THINKING = {
  off: 'none',
  minimal: 'low',
  low: 'low',
  medium: 'medium',
  high: 'xhigh',
  xhigh: 'xhigh',
  max: 'xhigh',
} as const satisfies ThinkingMap

const DASHSCOPE_COMPAT = {
  ...NO_STORE,
  supportsReasoningEffort: true,
  maxTokensField: 'max_completion_tokens',
  thinkingFormat: 'openai',
} as const satisfies CompletionsCompat

/** Doubao Seed 2.1: thinking.type enabled/disabled plus reasoning_effort. Omit off so pi sends type:disabled. */
const DOUBAO_THINKING = {
  minimal: 'minimal',
  low: 'low',
  medium: 'medium',
  high: 'high',
} as const satisfies ThinkingMap

const DOUBAO_COMPAT = {
  ...NO_STORE,
  supportsReasoningEffort: true,
  maxTokensField: 'max_tokens',
  thinkingFormat: 'deepseek',
  requiresReasoningContentOnAssistantMessages: true,
} as const satisfies CompletionsCompat

const GROQ_COMPAT = {
  ...NO_STORE,
  supportsReasoningEffort: false,
  maxTokensField: 'max_completion_tokens',
  thinkingFormat: 'openai',
} as const satisfies CompletionsCompat

const OPENROUTER_THINKING = {
  off: 'low',
  minimal: 'low',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'high',
  max: 'high',
} as const satisfies ThinkingMap

const OPENROUTER_COMPAT = {
  ...NO_STORE,
  supportsReasoningEffort: true,
  maxTokensField: 'max_completion_tokens',
  thinkingFormat: 'openrouter',
  sendSessionAffinityHeaders: true,
  sessionAffinityFormat: 'openrouter',
} as const satisfies CompletionsCompat

const MISTRAL_COMPAT = {
  ...NO_STORE,
  supportsReasoningEffort: false,
  maxTokensField: 'max_tokens',
  thinkingFormat: 'openai',
} as const satisfies CompletionsCompat

const CUSTOM_COMPAT = {
  ...NO_STORE,
  supportsReasoningEffort: false,
  maxTokensField: 'max_tokens',
  thinkingFormat: 'openai',
} as const satisfies CompletionsCompat

/** Haiku 5.5 / Sonnet 5.5 / Opus 5.5: thinking.type adaptive + output_config.effort. Cannot disable. */
const CLAUDE_THINKING = {
  off: null,
  minimal: null,
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
} as const satisfies ThinkingMap

const CLAUDE_COMPAT = {
  forceAdaptiveThinking: true,
  supportsTemperature: false,
} as const satisfies AnthropicCompat

interface CompletionsProfile {
  reasoning: boolean
  compat: CompletionsCompat
  thinkingLevelMap?: ThinkingMap
}

interface ResponsesProfile {
  reasoning: boolean
  maxTokens: number
  compat: ResponsesCompat
  thinkingLevelMap: ThinkingMap
}

const COMPLETIONS_PROFILES: Record<string, CompletionsProfile> = {
  kimi: { reasoning: true, compat: KIMI_COMPAT, thinkingLevelMap: KIMI_THINKING },
  deepseek: { reasoning: true, compat: DEEPSEEK_COMPAT },
  minimax: { reasoning: true, compat: MINIMAX_COMPAT, thinkingLevelMap: MINIMAX_THINKING },
  zhipu: { reasoning: true, compat: ZHIPU_COMPAT, thinkingLevelMap: ZHIPU_THINKING },
  gemini: { reasoning: true, compat: GEMINI_COMPAT, thinkingLevelMap: GEMINI_THINKING },
  dashscope: { reasoning: true, compat: DASHSCOPE_COMPAT, thinkingLevelMap: QWEN_THINKING },
  doubao: { reasoning: true, compat: DOUBAO_COMPAT, thinkingLevelMap: DOUBAO_THINKING },
  groq: { reasoning: false, compat: GROQ_COMPAT },
  openrouter: { reasoning: true, compat: OPENROUTER_COMPAT, thinkingLevelMap: OPENROUTER_THINKING },
  mistral: { reasoning: false, compat: MISTRAL_COMPAT },
  custom: { reasoning: false, compat: CUSTOM_COMPAT },
}

const RESPONSES_PROFILES: Record<string, ResponsesProfile> = {
  openai: { reasoning: true, maxTokens: 4_096, compat: OPENAI_RESPONSES_COMPAT, thinkingLevelMap: OPENAI_THINKING },
  xai: { reasoning: true, maxTokens: 4_096, compat: XAI_RESPONSES_COMPAT, thinkingLevelMap: XAI_THINKING },
}

export interface ResolvedLlm {
  models: ReturnType<typeof createModels>
  model: Model<'openai-completions'> | Model<'openai-responses'> | Model<'anthropic-messages'>
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
  const resolved = trimmed || catalogBaseUrl(config.provider)
  const normalized = resolved.replace(/\/+$/, '')
  if (config.provider === 'zhipu' && normalized === ZHIPU_RESPONSES) {
    return catalogBaseUrl('zhipu')
  }
  if (config.provider === 'minimax' && normalized === MINIMAX_LEGACY_COMPLETIONS) {
    return catalogBaseUrl('minimax')
  }
  return resolved
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

function completionsModel(config: LlmConfig, baseUrl: string): Model<'openai-completions'> {
  const profile = COMPLETIONS_PROFILES[config.provider] ?? COMPLETIONS_PROFILES.custom
  return {
    id: config.model,
    name: config.model,
    api: 'openai-completions',
    provider: config.provider,
    baseUrl,
    reasoning: profile.reasoning,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 4_096,
    compat: profile.compat,
    ...(profile.thinkingLevelMap ? { thinkingLevelMap: { ...profile.thinkingLevelMap } } : {}),
  }
}

function responsesModel(config: LlmConfig, baseUrl: string): Model<'openai-responses'> {
  const profile = RESPONSES_PROFILES[config.provider] ?? RESPONSES_PROFILES.openai
  return {
    id: config.model,
    name: config.model,
    api: 'openai-responses',
    provider: config.provider,
    baseUrl,
    reasoning: profile.reasoning,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: profile.maxTokens,
    thinkingLevelMap: { ...profile.thinkingLevelMap },
    compat: profile.compat,
  }
}

export function resolveLlm(config: LlmConfig): ResolvedLlm {
  const baseUrl = effectiveBaseUrl(config)
  const apiKey = config.apiKey
  const models = createModels()
  if (llmApi(config.provider) === 'anthropic-messages') {
    const template = anthropicProvider()
    const listed = template.getAllModels?.() ?? []
    const sample = listed.find((item) => item.id === config.model)
      ?? listed.find((item) => item.id === 'claude-haiku-5-5')
      ?? listed.find((item) => item.id === 'claude-sonnet-4-5')
      ?? listed[0]
    if (!sample) throw new Error('Claude provider has no model template')
    const model = {
      ...sample,
      id: config.model,
      name: config.model,
      provider: 'claude',
      baseUrl,
      reasoning: true,
      thinkingLevelMap: { ...CLAUDE_THINKING },
      compat: { ...CLAUDE_COMPAT },
    } as Model<'anthropic-messages'>
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
  const auth = { apiKey: passthroughApiKeyAuth(`${label} API key`) }
  if (llmApi(config.provider) === 'openai-responses') {
    const model = responsesModel(config, baseUrl)
    models.setProvider(createProvider({
      id: config.provider,
      name: label,
      baseUrl,
      auth,
      models: [model],
      api: openAIResponsesApi(),
    }))
    const resolved = models.getModel(config.provider, config.model)
    if (!resolved || !('api' in resolved) || resolved.api !== 'openai-responses') {
      throw new Error('pi-ai did not register the configured model')
    }
    return { models, model: resolved as Model<'openai-responses'>, apiKey }
  }
  const model = completionsModel(config, baseUrl)
  models.setProvider(createProvider({
    id: config.provider,
    name: label,
    baseUrl,
    auth,
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
