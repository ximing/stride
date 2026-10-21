import { Service } from '@rabjs/react'
import {
  redactSecret,
  resolveLlm,
  toolsForAgentMode,
  vaultTools,
  type LlmConfig,
} from '@stride/core'
import { appendAssistantDelta, appendToolEnd, appendToolStart, playChatTurn, type ChatSession } from './chat-turn'
import { chatSystemPrompt, chatVaultHost } from './chat-vault-host'
import { SettingsService } from '../settings/settings.service'
import { VaultService } from '../vault/vault.service'

export class ChatService extends Service {
  draft = ''
  error = ''
  running = false
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
    const runtime = this.settings.llmRuntime()
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
      await playChatTurn({
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
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Agent failed'
      this.error = redactSecret(message, runtime.apiKey)
    } finally {
      this.running = false
      this.controller = null
    }
  }
}
