import { Agent, type AgentTool } from '@earendil-works/pi-agent-core'
import {
  Type,
  createModels,
  createProvider,
  type ApiKeyAuth,
  type Model,
} from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import type { LlmSettings } from './settings.ts'

export interface ChatLine {
  role: 'user' | 'assistant'
  text: string
}

const LOCAL_COMPAT = {
  supportsStore: false,
  supportsDeveloperRole: false,
  supportsReasoningEffort: false,
  supportsUsageInStreaming: false,
  maxTokensField: 'max_tokens' as const,
  supportsStrictMode: false,
}

function passthroughApiKeyAuth(name: string): ApiKeyAuth {
  return {
    name,
    resolve: ({ credential }) =>
      Promise.resolve(credential?.key ? { auth: { apiKey: credential.key }, source: name } : undefined),
  }
}

export function chatModel(settings: LlmSettings): Model<'openai-completions'> {
  return {
    id: settings.model,
    name: settings.model,
    api: 'openai-completions',
    provider: settings.provider,
    baseUrl: settings.baseUrl,
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 4_096,
    compat: LOCAL_COMPAT,
  }
}

export interface VaultToolHost {
  readNote: (id: string) => Promise<string> | string
  searchVault: (query: string) => Promise<string> | string
  writeNote: (id: string, text: string) => Promise<string> | string
  activeNoteId?: string
}

function toolText(text: string, details: unknown = null) {
  return { content: [{ type: 'text' as const, text }], details }
}

export function vaultTools(host: VaultToolHost): AgentTool[] {
  const readNote: AgentTool = {
    name: 'read_note',
    label: 'Read note',
    description: 'Read the plain text of a vault note by id.',
    parameters: Type.Object({ id: Type.String({ minLength: 1 }) }),
    execute: async (_toolCallId, params) => {
      const record = params as { id: string }
      const text = await host.readNote(record.id)
      return toolText(text, { id: record.id, text })
    },
  }
  const readActive: AgentTool = {
    name: 'read_active_note',
    label: 'Read active note',
    description: 'Read the plain text of the note currently open in the vault.',
    parameters: Type.Object({}),
    execute: async () => {
      if (!host.activeNoteId) throw new Error('No note is open')
      const text = await host.readNote(host.activeNoteId)
      return toolText(text, { id: host.activeNoteId, text })
    },
  }
  const search: AgentTool = {
    name: 'search_vault',
    label: 'Search vault',
    description: 'Search vault notes. Returns matching note ids.',
    parameters: Type.Object({ query: Type.String({ minLength: 1 }) }),
    execute: async (_toolCallId, params) => {
      const record = params as { query: string }
      const text = await host.searchVault(record.query)
      return toolText(text, { query: record.query })
    },
  }
  const write: AgentTool = {
    name: 'write_note',
    label: 'Write note',
    description: 'Replace the body text of a note.',
    parameters: Type.Object({
      id: Type.String({ minLength: 1 }),
      text: Type.String(),
    }),
    execute: async (_toolCallId, params) => {
      const record = params as { id: string; text: string }
      const text = await host.writeNote(record.id, record.text)
      return toolText(text, { id: record.id })
    },
  }
  return [readNote, readActive, search, write]
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => {
      if (!part || typeof part !== 'object') return ''
      const block = part as { type?: string; text?: string }
      return block.type === 'text' && typeof block.text === 'string' ? block.text : ''
    })
    .join('')
}

function lastAssistant(messages: readonly unknown[]): string {
  let error = ''
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i] as { role?: string; errorMessage?: string; stopReason?: string; content?: unknown }
    if (message.role !== 'assistant') continue
    if (message.stopReason === 'error' || message.stopReason === 'aborted') {
      error = message.errorMessage || `Agent stopped: ${message.stopReason}`
      continue
    }
    const text = textOf(message.content)
    if (text.trim()) return text
  }
  if (error) throw new Error(error)
  return ''
}

export async function runVaultTurn(input: {
  settings: LlmSettings
  history: ChatLine[]
  userText: string
  tools: AgentTool[]
}): Promise<{ history: ChatLine[]; reply: string; model: Model<'openai-completions'> }> {
  const model = chatModel(input.settings)
  const models = createModels()
  models.setProvider(
    createProvider({
      id: input.settings.provider,
      name: input.settings.provider,
      baseUrl: input.settings.baseUrl,
      auth: { apiKey: passthroughApiKeyAuth(`${input.settings.provider} API key`) },
      models: [model],
      api: openAICompletionsApi(),
    }),
  )
  const resolved = models.getModel(input.settings.provider, input.settings.model)
  if (!resolved || !('api' in resolved) || resolved.api !== 'openai-completions') {
    throw new Error('pi-ai did not register the configured model')
  }
  const prior = input.history.map((line) =>
    line.role === 'user'
      ? { role: 'user' as const, content: line.text, timestamp: Date.now() }
      : {
          role: 'assistant' as const,
          content: [{ type: 'text' as const, text: line.text }],
          api: 'openai-completions' as const,
          provider: input.settings.provider,
          model: input.settings.model,
          stopReason: 'stop' as const,
          timestamp: Date.now(),
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        },
  )
  const agent = new Agent({
    streamFn: (nextModel, context, options) =>
      models.streamSimple(nextModel, context, {
        ...options,
        apiKey: input.settings.apiKey,
      }),
    getApiKey: () => input.settings.apiKey,
    initialState: {
      systemPrompt: 'You are Stride, a local vault assistant. Use the vault tools to read and search notes before answering.',
      model: resolved,
      tools: input.tools,
      messages: prior,
    },
    toolExecution: 'sequential',
  })
  await agent.prompt(input.userText)
  const reply = lastAssistant(agent.state.messages)
  if (!reply.trim()) {
    const summary = agent.state.messages.map((message) => {
      const row = message as { role?: string; stopReason?: string; errorMessage?: string; content?: unknown }
      const content = row.content
      const kind = Array.isArray(content) ? content.map((part) => (part as { type?: string }).type).join(',') : typeof content
      return `${row.role}:${row.stopReason || ''}:${kind}:${row.errorMessage || ''}`
    }).join(' | ')
    throw new Error(agent.state.errorMessage || `Agent returned an empty reply (${summary})`)
  }
  return {
    history: [...input.history, { role: 'user', text: input.userText }, { role: 'assistant', text: reply }],
    reply,
    model: resolved as Model<'openai-completions'>,
  }
}
