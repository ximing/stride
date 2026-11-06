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

export type LlmApiKind = 'openai-completions' | 'openai-responses' | 'anthropic-messages'

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
  openai: ['gpt-6.1-terra', 'gpt-6.1-sol'],
  claude: ['claude-sonnet-5-5', 'claude-opus-5-5'],
  gemini: ['gemini-3.6-flash', 'gemini-3.5-flash-lite'],
  xai: ['grok-4.6', 'grok-4.5', 'grok-4.3'],
  mistral: ['mistral-medium-latest', 'mistral-large-latest', 'codestral-latest'],
  kimi: ['kimi-k3.1-pro', 'kimi-k3'],
  deepseek: ['deepseek-v4-pro'],
  zhipu: ['glm-5.3-flashx', 'glm-5.3'],
  dashscope: ['qwen-flash', 'qwen3.8-max'],
  minimax: ['MiniMax-M3'],
  doubao: ['doubao-seed-2-1-pro-260915', 'doubao-seed-evolving'],
  groq: ['llama-3.3-70b-versatile', 'openai/gpt-oss-20b'],
  openrouter: ['anthropic/claude-haiku-5.5', 'openai/gpt-6-luna'],
}

function suggestionsFor(defaultModel: string, id: LlmProviderId): readonly string[] {
  const extras = EXTRA_MODELS[id] ?? []
  if (!defaultModel) return extras
  return [defaultModel, ...extras]
}

export const LLM_PROVIDERS: readonly LlmProviderInfo[] = [
  { id: 'openai', label: 'OpenAI', api: 'openai-responses', baseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-6-luna', suggestions: suggestionsFor('gpt-6-luna', 'openai') },
  { id: 'deepseek', label: 'DeepSeek', api: 'openai-completions', baseUrl: 'https://api.deepseek.com', defaultModel: 'deepseek-flash', suggestions: suggestionsFor('deepseek-flash', 'deepseek') },
  { id: 'claude', label: 'Claude', api: 'anthropic-messages', baseUrl: 'https://api.anthropic.com', defaultModel: 'claude-haiku-5-5', suggestions: suggestionsFor('claude-haiku-5-5', 'claude') },
  { id: 'gemini', label: 'Gemini', api: 'openai-completions', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', defaultModel: 'gemini-3.8-flash', suggestions: suggestionsFor('gemini-3.8-flash', 'gemini') },
  { id: 'xai', label: 'Grok', api: 'openai-responses', baseUrl: 'https://api.x.ai/v1', defaultModel: 'grok-4.7', suggestions: suggestionsFor('grok-4.7', 'xai') },
  { id: 'mistral', label: 'Mistral', api: 'openai-completions', baseUrl: 'https://api.mistral.ai/v1', defaultModel: 'mistral-small-latest', suggestions: suggestionsFor('mistral-small-latest', 'mistral') },
  { id: 'zhipu', label: '智谱', api: 'openai-responses', baseUrl: 'https://open.bigmodel.cn/api/v1', defaultModel: 'glm-5.3-flash', suggestions: suggestionsFor('glm-5.3-flash', 'zhipu') },
  { id: 'dashscope', label: '通义百炼', api: 'openai-completions', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', defaultModel: 'qwen3.8-flash', suggestions: suggestionsFor('qwen3.8-flash', 'dashscope') },
  { id: 'kimi', label: 'Kimi', api: 'openai-completions', baseUrl: 'https://api.moonshot.cn/v1', defaultModel: 'kimi-k3.1-pro-highspeed', suggestions: suggestionsFor('kimi-k3.1-pro-highspeed', 'kimi') },
  { id: 'minimax', label: 'MiniMax', api: 'openai-completions', baseUrl: 'https://api.minimax.cn/v1', defaultModel: 'MiniMax-M3.1-Flash', suggestions: suggestionsFor('MiniMax-M3.1-Flash', 'minimax') },
  { id: 'doubao', label: '豆包', api: 'openai-completions', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', defaultModel: 'doubao-seed-2-1-lite-260915', suggestions: suggestionsFor('doubao-seed-2-1-lite-260915', 'doubao') },
  { id: 'groq', label: 'Groq', api: 'openai-completions', baseUrl: 'https://api.groq.com/openai/v1', defaultModel: 'llama-3.1-8b-instant', suggestions: suggestionsFor('llama-3.1-8b-instant', 'groq') },
  { id: 'openrouter', label: 'OpenRouter', api: 'openai-completions', baseUrl: 'https://openrouter.ai/api/v1', defaultModel: 'google/gemini-3.8-flash', suggestions: suggestionsFor('google/gemini-3.8-flash', 'openrouter') },
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
