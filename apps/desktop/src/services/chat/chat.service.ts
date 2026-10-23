import { Service } from '@rabjs/react'
import {
  redactSecret,
  resolveLlm,
  toolsForAgentMode,
  vaultTools,
  type LlmConfig,
} from '@stride/core'
import { appendAssistantDelta, appendToolEnd, appendToolStart, playChatTurn, type ChatSession } from './chat-turn'

/** Stored in `error` when the loop stops at max turns. The panel translates it. */
export const CHAT_TURN_LIMIT_ERROR = 'max-turns'
import { chatSystemPrompt, chatVaultHost } from './chat-vault-host'
import { SettingsService } from '../settings/settings.service'
import { VaultService } from '../vault/vault.service'

export class ChatService extends Service {
  draft = ''
  error = ''
  running = false
  /** Saved LLM config used for the next turn. Empty follows the settings default. */
  modelId = ''
  sessions: ChatSession[] = [{ id: 'session-1', title: 'New', messages: [] }]
  activeId = 'session-1'
  private controller: AbortController | null = null
  private vaultToolSet: { id: string; tools: ReturnType<typeof vaultTools> } | null = null

  private get settings() {
    return this.resolve(SettingsService)
  }

  setDraft(value: string) {
    this.draft = value
  }

  setModel(id: string) {
    if (!this.settings.form.llmConfigs.some((config) => config.id === id)) return
    this.modelId = id
  }

  /** Config for the composer. An unknown id falls back to the default, then the first saved config. */
  get activeModelId(): string {
    const configs = this.settings.form.llmConfigs
    if (this.modelId && configs.some((config) => config.id === this.modelId)) return this.modelId
    return configs.find((config) => config.isDefault)?.id ?? configs[0]?.id ?? ''
  }

  select(id: string) {
    if (this.sessions.some((session) => session.id === id)) this.activeId = id
  }

  newSession() {
    const id = `session-${crypto.randomUUID()}`
    this.sessions.push({ id, title: 'New', messages: [] })
    this.activeId = id
  }

  abort() {
    this.controller?.abort()
  }

  private vaultTools() {
    const vault = this.resolve(VaultService)
    const id = `${vault.activeVaultId || 'none'}:${vault.agentMode}`
    if (!this.vaultToolSet || this.vaultToolSet.id !== id) {
      this.vaultToolSet = { id, tools: toolsForAgentMode(vaultTools(chatVaultHost(vault)), vault.agentMode) }
    }
    return this.vaultToolSet.tools
  }

  async send() {
    const text = this.draft.trim()
    if (!text || this.running) return
    const runtime = this.settings.llmRuntime(this.activeModelId || undefined)
    if (!runtime?.apiKey || !runtime.model || !runtime.baseUrl) {
      this.error = 'Add a model provider, base URL, model, and key in Settings'
      return
    }
    const session = this.sessions.find((item) => item.id === this.activeId)
    if (!session) return
    this.error = ''
    this.draft = ''
    if (session.title === 'New') session.title = text.slice(0, 32)
    session.messages.push({ role: 'user', text, thinking: '', tools: [] })
    session.messages.push({ role: 'assistant', text: '', thinking: '', tools: [] })
    const sessionId = session.id
    this.running = true
    const controller = new AbortController()
    this.controller = controller
    try {
      const config: LlmConfig = {
        id: 'active',
        name: runtime.provider,
        provider: runtime.provider,
        model: runtime.model,
        baseUrl: this.settings.devLlmBaseUrl(runtime.baseUrl),
        apiKey: runtime.apiKey,
        isDefault: true,
      }
      const resolved = resolveLlm(config)
      const result = await playChatTurn({
        model: resolved.model,
        apiKey: resolved.apiKey,
        systemPrompt: chatSystemPrompt(this.resolve(VaultService)),
        prompt: text,
        tools: this.vaultTools(),
        signal: controller.signal,
        streamFn: (model, context, options) => resolved.models.streamSimple(model, context, {
          ...options,
          apiKey: resolved.apiKey,
        }),
        onText: (delta) => appendAssistantDelta(this.sessions, sessionId, 'text', delta),
        onThinking: (delta) => appendAssistantDelta(this.sessions, sessionId, 'thinking', delta),
        onToolStart: (call) => appendToolStart(this.sessions, sessionId, call),
        onToolEnd: (call) => appendToolEnd(this.sessions, sessionId, call),
        onUsage: (usage) => this.settings.recordTokenUsage({
          model: runtime.model,
          input: usage.input,
          output: usage.output,
          cacheRead: usage.cacheRead,
          cacheWrite: usage.cacheWrite,
          total: usage.totalTokens,
        }),
      })
      if (result.turnLimit && !result.aborted) this.error = CHAT_TURN_LIMIT_ERROR
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Agent failed'
      this.error = redactSecret(message, runtime.apiKey)
    } finally {
      this.running = false
      this.controller = null
    }
  }
}
