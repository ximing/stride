export const LLM_PROVIDER_IDS = [
  'openai',
  'deepseek',
  'claude',
  'gemini',
  'xai',
  'mistral',
  'zhipu',
  'dashscope',
  'kimi',
  'minimax',
  'doubao',
  'groq',
  'openrouter',
  'custom',
] as const

export type LlmProviderId = (typeof LLM_PROVIDER_IDS)[number]

export type LlmApiKind = 'openai-completions' | 'anthropic-messages'

export interface LlmProviderInfo {
  id: LlmProviderId
  label: string
  api: LlmApiKind
  baseUrl: string
  defaultModel: string
  /** Default model first, then suggestion-only extras. */
  suggestions: readonly string[]
}

const EXTRA_MODELS: Partial<Record<LlmProviderId, readonly string[]>> = {
  gemini: ['gemini-2.5-pro', 'gemini-3.8-flash'],
  xai: ['grok-4.6', 'grok-4.5', 'grok-4.3'],
  mistral: ['mistral-medium-latest', 'mistral-large-latest', 'codestral-latest'],
  kimi: ['kimi-k2.7-code', 'kimi-k2.7-code-highspeed', 'kimi-k2.6'],
  minimax: ['MiniMax-M2.7-highspeed', 'MiniMax-M3'],
  doubao: ['doubao-seed-1-6-251015'],
  groq: ['llama-3.1-8b-instant', 'qwen/qwen3.6-27b'],
  openrouter: ['anthropic/claude-sonnet-4.5', 'deepseek/deepseek-chat'],
}

function suggestionsFor(defaultModel: string, id: LlmProviderId): readonly string[] {
  const extras = EXTRA_MODELS[id] ?? []
  if (!defaultModel) return extras
  return [defaultModel, ...extras]
}

export const LLM_PROVIDERS: readonly LlmProviderInfo[] = [
  { id: 'openai', label: 'OpenAI', api: 'openai-completions', baseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-4o-mini', suggestions: suggestionsFor('gpt-4o-mini', 'openai') },
  { id: 'deepseek', label: 'DeepSeek', api: 'openai-completions', baseUrl: 'https://api.deepseek.com', defaultModel: 'deepseek-chat', suggestions: suggestionsFor('deepseek-chat', 'deepseek') },
  { id: 'claude', label: 'Claude', api: 'anthropic-messages', baseUrl: 'https://api.anthropic.com', defaultModel: 'claude-sonnet-4-5', suggestions: suggestionsFor('claude-sonnet-4-5', 'claude') },
  { id: 'gemini', label: 'Gemini', api: 'openai-completions', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', defaultModel: 'gemini-2.5-flash', suggestions: suggestionsFor('gemini-2.5-flash', 'gemini') },
  { id: 'xai', label: 'Grok', api: 'openai-completions', baseUrl: 'https://api.x.ai/v1', defaultModel: 'grok-4.7', suggestions: suggestionsFor('grok-4.7', 'xai') },
  { id: 'mistral', label: 'Mistral', api: 'openai-completions', baseUrl: 'https://api.mistral.ai/v1', defaultModel: 'mistral-small-latest', suggestions: suggestionsFor('mistral-small-latest', 'mistral') },
  { id: 'zhipu', label: '智谱', api: 'openai-completions', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', defaultModel: 'glm-4', suggestions: suggestionsFor('glm-4', 'zhipu') },
  { id: 'dashscope', label: '通义百炼', api: 'openai-completions', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', defaultModel: 'qwen-plus', suggestions: suggestionsFor('qwen-plus', 'dashscope') },
  { id: 'kimi', label: 'Kimi', api: 'openai-completions', baseUrl: 'https://api.moonshot.cn/v1', defaultModel: 'kimi-k3', suggestions: suggestionsFor('kimi-k3', 'kimi') },
  { id: 'minimax', label: 'MiniMax', api: 'openai-completions', baseUrl: 'https://api.minimaxi.com/v1', defaultModel: 'MiniMax-M2.7', suggestions: suggestionsFor('MiniMax-M2.7', 'minimax') },
  { id: 'doubao', label: '豆包', api: 'openai-completions', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', defaultModel: 'doubao-seed-2-1-pro-260628', suggestions: suggestionsFor('doubao-seed-2-1-pro-260628', 'doubao') },
  { id: 'groq', label: 'Groq', api: 'openai-completions', baseUrl: 'https://api.groq.com/openai/v1', defaultModel: 'llama-3.3-70b-versatile', suggestions: suggestionsFor('llama-3.3-70b-versatile', 'groq') },
  { id: 'openrouter', label: 'OpenRouter', api: 'openai-completions', baseUrl: 'https://openrouter.ai/api/v1', defaultModel: 'google/gemini-2.5-flash', suggestions: suggestionsFor('google/gemini-2.5-flash', 'openrouter') },
  { id: 'custom', label: 'Custom', api: 'openai-completions', baseUrl: '', defaultModel: '', suggestions: suggestionsFor('', 'custom') },
]

const BY_ID = new Map(LLM_PROVIDERS.map((provider) => [provider.id, provider]))

export function isLlmProvider(value: string): value is LlmProviderId {
  return BY_ID.has(value as LlmProviderId)
}

export function llmProviderInfo(provider: string): LlmProviderInfo | undefined {
  return isLlmProvider(provider) ? BY_ID.get(provider) : undefined
}

export function llmApi(provider: string): LlmApiKind {
  return llmProviderInfo(provider)?.api ?? 'openai-completions'
}

export function catalogBaseUrl(provider: string): string {
  return llmProviderInfo(provider)?.baseUrl ?? ''
}

export function catalogDefaultModel(provider: string): string {
  return llmProviderInfo(provider)?.defaultModel ?? ''
}

export function catalogModelSuggestions(provider: string): readonly string[] {
  return llmProviderInfo(provider)?.suggestions ?? []
}
