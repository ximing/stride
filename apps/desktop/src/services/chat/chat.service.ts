import { Service } from '@rabjs/react'
import {
  buildMemorySection,
  memoryTools,
  newSessionId,
  parseSession,
  parseSessionMeta,
  redactSecret,
  resolveLlm,
  serializeSession,
  serializeSessionMeta,
  sessionTitleFromText,
  stripSystemMessages,
  toolsForAgentMode,
  truncateTranscript,
  vaultStorageKey,
  vaultTools,
  type AgentUsage,
  type ChatSessionFile,
  type ChatSessionMessage,
  type ChatSessionMeta,
  type LlmConfig,
  type MemoryEntry,
  type MemoryIndex,
  type MemoryIndexEntry,
  type MemoryScope,
  type MemoryToolHost,
} from '@stride/core'
import {
  appendAssistantDelta,
  appendToolEnd,
  appendToolStart,
  blankChatSession,
  ChatTurnError,
  emptyChatUsage,
  newChatMessageId,
  playChatTurn,
  type ChatMessage,
  type ChatSession,
} from './chat-turn'

/** Stored in `error` when the loop stops at max turns. The panel translates it. */
export const CHAT_TURN_LIMIT_ERROR = 'max-turns'
/** Stored in `error` when a persisted session cannot be read back. The panel translates it. */
export const CHAT_HISTORY_LOAD_ERROR = 'history-load-failed'
/** Stored in `memoryError` when a background memory pass fails. The panel translates it. */
export { CHAT_MEMORY_WORK_ERROR }
import { chatSystemPrompt, chatVaultHost } from './chat-vault-host'
import { chatMemoryHostKeyed } from './chat-memory-host'
import { CHAT_MEMORY_WORK_ERROR, ChatMemoryDistiller } from './chat-memory-distill'
import { resolveAppDataStore } from '../platform/app-data'
import { closeOtherOverlays } from '../platform/overlays'
import { hostFetch } from '../platform/host-fetch'
import { SettingsService } from '../settings/settings.service'
import { VaultService } from '../vault/vault.service'

function addUsage(left: AgentUsage, right: AgentUsage): AgentUsage {
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite,
    totalTokens: left.totalTokens + right.totalTokens,
    costTotal: left.costTotal + right.costTotal,
  }
}

function toSessionMessage(message: ChatMessage): ChatSessionMessage {
  return {
    id: message.id ?? newChatMessageId(),
    role: message.role,
    text: message.text,
    thinking: message.thinking,
    ts: message.ts ?? new Date().toISOString(),
    tools: message.tools.map((tool) => ({ ...tool })),
  }
}

export class ChatService extends Service {
  draft = ''
  error = ''
  running = false
  /** Saved LLM config used for the next turn. Empty follows the settings default. */
  modelId = ''
  /** The one session on stage. History recall and vault switches replace it. */
  session: ChatSession = blankChatSession(newSessionId())
  /** History list data for the current vault, newest first. */
  metas: ChatSessionMeta[] = []
  historyLoaded = false
  historyOpen = false
  /** Null until the store resolves; false means sessions live in memory only. */
  storagePersistent: boolean | null = null
  /** True while a distillation/curation pass runs; the panel shows a cancelable status line. */
  memoryBusy = false
  /** CHAT_MEMORY_WORK_ERROR after a failed memory pass; '' clears it. */
  memoryError = ''
  private controller: AbortController | null = null
  private vaultToolSet: { id: string; tools: ReturnType<typeof vaultTools> } | null = null
  /** Vault key the current session area and metas belong to. */
  private vaultKeyLoaded: string | null = null
  private loadTicket = 0
  private writeChain: Promise<void> = Promise.resolve()
  /** Memory hosts per vault key; one instance per vault keeps writes on one queue. */
  private memoryHosts = new Map<string, MemoryToolHost>()
  private memoryToolSet: { id: string; tools: ReturnType<typeof memoryTools> } | null = null
  private readonly distiller = new ChatMemoryDistiller({
    runtime: () => this.settings.memoryRuntime(),
    baseUrl: (url) => this.settings.devLlmBaseUrl(url),
    host: (key) => this.memoryHost(key),
    sessionRunning: (id) => this.running && this.session.id === id,
    cursorAdvanced: (id, cursor) => {
      if (this.session.id === id) this.session.memory = { ...cursor }
    },
    setBusy: (busy) => {
      this.memoryBusy = busy
    },
    setError: (message) => {
      this.memoryError = message
    },
  })

  private get settings() {
    return this.resolve(SettingsService)
  }

  private get vault() {
    return this.resolve(VaultService)
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

  /** Model for the next turn: the session lock wins while its config still exists. */
  private turnModelId(): string {
    const locked = this.session.modelId
    if (locked && this.settings.form.llmConfigs.some((config) => config.id === locked)) return locked
    return this.activeModelId
  }

  /** Start a blank session. The previous one was already persisted at the end of its last turn. */
  newSession() {
    if (this.running) return
    this.session = blankChatSession(newSessionId())
    this.error = ''
  }

  /** Send `text` as the next user turn, continuing the current session. */
  async ask(text: string) {
    const prompt = text.trim()
    if (!prompt || this.running) return
    this.draft = prompt
    await this.send()
  }

  abort() {
    this.controller?.abort()
  }

  /** Close the current session: persist it as closed and return to a blank one. */
  async close() {
    if (this.running) return
    const session = this.session
    const vaultKey = this.currentVaultKey()
    if (session.messages.length > 0) {
      session.status = 'closed'
      await this.persist(session, vaultKey)
      // Session end trigger (design §6.1): distill the undistilled increment.
      this.requestDistill(vaultKey, session.id)
    }
    this.session = blankChatSession(newSessionId())
    this.error = ''
    await this.ensureLoaded()
  }

  showHistory() {
    if (this.historyOpen) return
    closeOtherOverlays('chatHistory', () => this.closeHistory())
    this.historyOpen = true
    void this.ensureLoaded()
  }

  closeHistory() {
    this.historyOpen = false
  }

  private currentVaultKey(): string {
    const id = this.vault.activeVaultId
    return id ? vaultStorageKey(id) : ''
  }

  /**
   * Load the History list for the active vault. Called when the panel opens,
   * before a send, and whenever the vault changes; a vault switch also resets
   * the session area to a blank session.
   */
  async ensureLoaded(): Promise<void> {
    const vaultKey = this.currentVaultKey()
    // The first call only anchors the key; the fresh blank session stays put.
    if (this.vaultKeyLoaded !== null && vaultKey !== this.vaultKeyLoaded) {
      // Vault switch trigger (design §6.1): the staged session just ended.
      if (this.session.messages.length > 0 && this.vaultKeyLoaded) {
        this.requestDistill(this.vaultKeyLoaded, this.session.id)
      }
      this.session = blankChatSession(newSessionId())
      this.error = ''
      this.metas = []
      this.historyLoaded = false
    }
    this.vaultKeyLoaded = vaultKey
    const ticket = ++this.loadTicket
    let store
    try {
      const resolved = await resolveAppDataStore()
      store = resolved.store
      if (ticket === this.loadTicket) this.storagePersistent = resolved.persistent
    } catch {
      return
    }
    if (!vaultKey) {
      if (ticket === this.loadTicket) {
        this.metas = []
        this.historyLoaded = true
      }
      return
    }
    try {
      const paths = await store.list(`chats/${vaultKey}/`)
      const metas: ChatSessionMeta[] = []
      for (const path of paths) {
        if (!path.endsWith('.meta.json')) continue
        try {
          const text = await store.readText(path)
          if (!text) continue
          const meta = parseSessionMeta(text)
          // Corrupt files are skipped, never fatal to the panel.
          if (meta) metas.push(meta)
        } catch {
          // Skip unreadable entries.
        }
      }
      metas.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      if (ticket === this.loadTicket && this.vaultKeyLoaded === vaultKey) {
        this.metas = metas
        this.historyLoaded = true
        // Startup trigger (design §6.1): catch up sessions left dirty at exit.
        if (this.memoryEnabled) this.distiller.scan(vaultKey, metas.map((meta) => meta.id))
      }
    } catch {
      if (ticket === this.loadTicket) this.historyLoaded = true
    }
  }

  /** Recall a persisted session and put it on stage for continuation. */
  async openFromHistory(id: string) {
    if (this.running) return
    const vaultKey = this.currentVaultKey()
    if (!vaultKey) return
    // Session switch trigger (design §6.1): the staged session just ended.
    if (this.session.messages.length > 0) this.requestDistill(vaultKey, this.session.id)
    try {
      const { store } = await resolveAppDataStore()
      const text = await store.readText(`chats/${vaultKey}/${id}.json`)
      const file = text ? parseSession(text) : null
      if (!file) {
        this.error = CHAT_HISTORY_LOAD_ERROR
        return
      }
      const meta = this.metas.find((item) => item.id === id) ?? null
      const firstUser = file.messages.find((message) => message.role === 'user')?.text ?? ''
      const now = new Date().toISOString()
      this.session = {
        id: file.id,
        title: meta?.title || sessionTitleFromText(firstUser) || 'New',
        createdAt: meta?.createdAt ?? now,
        updatedAt: meta?.updatedAt ?? now,
        // A closed session stays closed on stage; sending flips it back to active.
        status: meta?.status ?? 'active',
        modelId: meta?.modelId ?? '',
        messages: file.messages.map((message): ChatMessage => ({
          id: message.id,
          role: message.role,
          text: message.text,
          thinking: message.thinking,
          ts: message.ts,
          tools: message.tools.map((tool) => ({ ...tool })),
        })),
        transcript: file.transcript,
        memory: { ...file.memory },
        usage: meta?.usage ?? emptyChatUsage(),
      }
      this.error = ''
      this.historyOpen = false
    } catch {
      this.error = CHAT_HISTORY_LOAD_ERROR
    }
  }

  /** Delete a persisted session. Deleting the staged session returns to a blank one. */
  async deleteSession(id: string) {
    const vaultKey = this.currentVaultKey()
    if (vaultKey) {
      try {
        const { store } = await resolveAppDataStore()
        await store.remove(`chats/${vaultKey}/${id}.meta.json`)
        await store.remove(`chats/${vaultKey}/${id}.json`)
      } catch {
        // Deletion failures degrade silently; the entry just stays.
      }
    }
    this.metas = this.metas.filter((meta) => meta.id !== id)
    if (this.session.id === id && !this.running) {
      this.session = blankChatSession(newSessionId())
      this.error = ''
    }
  }

  private vaultTools() {
    const vault = this.vault
    const id = `${vault.activeVaultId || 'none'}:${vault.agentMode}`
    if (!this.vaultToolSet || this.vaultToolSet.id !== id) {
      this.vaultToolSet = { id, tools: toolsForAgentMode(vaultTools(chatVaultHost(vault)), vault.agentMode) }
    }
    return this.vaultToolSet.tools
  }

  private get memoryEnabled(): boolean {
    return this.settings.form.agent?.memoryEnabled !== false
  }

  private memoryHost(vaultKey: string): MemoryToolHost {
    let host = this.memoryHosts.get(vaultKey)
    if (!host) {
      host = chatMemoryHostKeyed(vaultKey)
      this.memoryHosts.set(vaultKey, host)
    }
    return host
  }

  /** Memory tools for one turn, cached per vault and session (the source stamp). */
  private memoryToolsFor(vaultKey: string, sessionId: string) {
    const id = `${vaultKey}:${sessionId}`
    if (!this.memoryToolSet || this.memoryToolSet.id !== id) {
      this.memoryToolSet = { id, tools: memoryTools(this.memoryHost(vaultKey), { source: { sessionId } }) }
    }
    return this.memoryToolSet.tools
  }

  /** Fresh two-scope index section for the system prompt; failures degrade to ''. */
  private async memorySection(vaultKey: string): Promise<string> {
    try {
      const host = this.memoryHost(vaultKey)
      const [project, globalScope] = await Promise.all([host.readIndex('project'), host.readIndex('global')])
      return buildMemorySection({ project, global: globalScope })
    } catch {
      return ''
    }
  }

  private requestDistill(vaultKey: string, sessionId: string) {
    if (!this.memoryEnabled) return
    this.distiller.request(vaultKey, sessionId)
  }

  /** Manual command: distill the staged session's undistilled increment now. */
  async distillMemoryNow() {
    if (this.running || !this.memoryEnabled) return
    const vaultKey = this.currentVaultKey()
    if (!vaultKey || this.session.messages.length === 0) return
    await this.persist(this.session, vaultKey)
    this.requestDistill(vaultKey, this.session.id)
  }

  /** Cancel the running memory pass; queued sessions stay for the next trigger. */
  cancelMemoryWork() {
    this.distiller.cancel()
  }

  /** Active memory entries for the settings Memory panel, newest first per scope. */
  async listMemories(): Promise<{ project: MemoryIndexEntry[]; global: MemoryIndexEntry[] }> {
    const host = this.memoryHost(this.currentVaultKey())
    const [project, globalScope] = await Promise.all([host.readIndex('project'), host.readIndex('global')])
    const active = (index: MemoryIndex | null): MemoryIndexEntry[] =>
      (index?.entries ?? [])
        .filter((entry) => entry.status === 'active')
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    return { project: active(project), global: active(globalScope) }
  }

  /** Full content of one memory entry; the panel loads it lazily on expand. */
  async readMemory(scope: MemoryScope, id: string): Promise<MemoryEntry | null> {
    return this.memoryHost(this.currentVaultKey()).readEntry(scope, id)
  }

  /** Test hook: drops distiller bookkeeping between cases. */
  resetMemoryWork() {
    this.distiller.reset()
  }

  /** Test hook: resolves when background memory work is done. */
  whenMemorySettled(): Promise<void> {
    return this.distiller.whenSettled()
  }

  async send() {
    const text = this.draft.trim()
    if (!text || this.running) return
    // Fail fast — synchronously, like the loop used to — when no model is set up.
    const early = this.settings.llmRuntime(this.turnModelId() || undefined)
    if (!early?.apiKey || !early.model || !early.baseUrl) {
      this.error = 'Add a model provider, base URL, model, and key in Settings'
      return
    }
    await this.ensureLoaded()
    const vaultKey = this.currentVaultKey()
    const session = this.session
    const modelId = this.turnModelId()
    const runtime = this.settings.llmRuntime(modelId || undefined)
    if (!runtime?.apiKey || !runtime.model || !runtime.baseUrl) {
      this.error = 'Add a model provider, base URL, model, and key in Settings'
      return
    }
    this.error = ''
    this.memoryError = ''
    this.draft = ''
    if (session.status === 'closed') session.status = 'active'
    if (session.title === 'New') session.title = sessionTitleFromText(text) || 'New'
    const memoryOn = this.memoryEnabled
    // Read both indexes fresh every turn; they are small and change between turns.
    const memorySection = memoryOn ? await this.memorySection(vaultKey) : ''
    const tools = memoryOn ? [...this.vaultTools(), ...this.memoryToolsFor(vaultKey, session.id)] : this.vaultTools()
    const ts = new Date().toISOString()
    session.messages.push({ id: newChatMessageId(), role: 'user', text, thinking: '', tools: [], ts })
    session.messages.push({ id: newChatMessageId(), role: 'assistant', text: '', thinking: '', tools: [], ts })
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
        systemPrompt: chatSystemPrompt(this.vault, memorySection, memoryOn),
        prompt: text,
        history: session.transcript,
        tools,
        maxTurns: this.settings.form.agent?.maxTurns,
        signal: controller.signal,
        streamFn: (model, context, options) => resolved.models.streamSimple(model, context, {
          ...options,
          apiKey: resolved.apiKey,
          fetch: hostFetch,
        }),
        // The captured array pins deltas to the session that started the turn,
        // even if the user recalls another session mid-run.
        onText: (delta) => appendAssistantDelta([session], session.id, 'text', delta),
        onThinking: (delta) => appendAssistantDelta([session], session.id, 'thinking', delta),
        onToolStart: (call) => appendToolStart([session], session.id, call),
        onToolEnd: (call) => appendToolEnd([session], session.id, call),
        onUsage: (usage) => this.settings.recordTokenUsage({
          model: runtime.model,
          input: usage.input,
          output: usage.output,
          cacheRead: usage.cacheRead,
          cacheWrite: usage.cacheWrite,
          total: usage.totalTokens,
        }),
      })
      session.transcript = result.transcript
      session.usage = addUsage(session.usage, result.usage)
      // The first completed assistant turn locks the session model.
      if (!session.modelId) session.modelId = modelId
      if (result.turnLimit && !result.aborted) this.error = CHAT_TURN_LIMIT_ERROR
    } catch (error) {
      if (error instanceof ChatTurnError) session.transcript = error.transcript
      const message = error instanceof Error ? error.message : 'Agent failed'
      this.error = redactSecret(message, runtime.apiKey)
    } finally {
      this.running = false
      this.controller = null
      // Done, aborted, and failed turns all persist; this is the data-safety guarantee.
      await this.persist(session, vaultKey)
    }
  }

  /** Writes are chained so a close cannot be overwritten by an in-flight turn persist. */
  private persist(session: ChatSession, vaultKey: string): Promise<void> {
    const run = this.writeChain.then(() => this.persistNow(session, vaultKey))
    this.writeChain = run.then(() => undefined, () => undefined)
    return run
  }

  private async persistNow(session: ChatSession, vaultKey: string): Promise<void> {
    if (!vaultKey || session.messages.length === 0) return
    try {
      const { store } = await resolveAppDataStore()
      const now = new Date().toISOString()
      session.updatedAt = now
      const meta: ChatSessionMeta = {
        format: 1,
        id: session.id,
        vaultKey,
        vaultLabel: this.vault.currentVaultLabel,
        title: session.title,
        createdAt: session.createdAt,
        updatedAt: now,
        status: session.status,
        modelId: session.modelId,
        messageCount: session.messages.length,
        usage: session.usage,
      }
      const file: ChatSessionFile = {
        format: 1,
        id: session.id,
        messages: session.messages.map(toSessionMessage),
        // Tool results are capped first, then system messages are stripped:
        // the persisted transcript must be replay-safe and bounded.
        transcript: stripSystemMessages(truncateTranscript(session.transcript)),
        memory: { ...session.memory },
      }
      await store.writeText(`chats/${vaultKey}/${session.id}.meta.json`, serializeSessionMeta(meta))
      await store.writeText(`chats/${vaultKey}/${session.id}.json`, serializeSession(file))
      // Keep the loaded History list in sync without a full reload.
      if (this.vaultKeyLoaded === vaultKey) {
        const rest = this.metas.filter((item) => item.id !== meta.id)
        this.metas = [meta, ...rest].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      }
    } catch {
      // Persistence must never break the chat surface.
    }
  }
}
