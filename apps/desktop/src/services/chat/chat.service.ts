import { has, raw, resolve, Service } from '@rabjs/react'
import {
  buildMemorySection,
  buildResumePreface,
  listNoteFiles,
  memoryTools,
  newSessionId,
  noteIdFromPath,
  notePath,
  parseExternalSlots,
  parseNote,
  parseSession,
  parseSessionMeta,
  redactSecret,
  resolveLlm,
  serializeNote,
  serializeSession,
  serializeSessionMeta,
  sessionTitleFromText,
  stripSystemMessages,
  toolsForAgentMode,
  EXTERNAL_AGENT_CODES,
  ExternalAgentError,
  ExternalAgentSession,
  isExternalAgentMode,
  truncateTranscript,
  vaultStorageKey,
  vaultTools,
  type AgentUsage,
  type ChatExternalSlots,
  type ChatSessionFile,
  type ChatSessionMessage,
  type ChatSessionMeta,
  type ExternalActivity,
  type ExternalCliMode,
  type LlmConfig,
  type MemoryEntry,
  type MemoryIndex,
  type MemoryIndexEntry,
  type MemoryScope,
  type MemoryToolHost,
  type StrideNote,
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

const EXTERNAL_ACTIVITY_CAP = 40
const FAILURE_DETAIL_MAX = 500
const RESUME_FAILED = 'external-agent-resume-failed'

function longestSecrets(secrets: readonly string[]): string[] {
  return [...secrets].filter((secret) => secret !== '').sort((left, right) => right.length - left.length)
}

function redactText(text: string, secrets: readonly string[]): string {
  let out = text
  for (const secret of secrets) out = redactSecret(out, secret)
  return out
}

function redactValue(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === 'string') return redactText(value, secrets)
  if (Array.isArray(value)) return value.map((item) => redactValue(item, secrets))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[redactText(key, secrets)] = redactValue(item, secrets)
    }
    return out
  }
  return value
}

/** Redact a failed CLI detail and cap it. Stable `external-agent-*` codes are not passed through here. */
export function redactExternalFailure(detail: string, secrets: readonly string[]): string {
  return redactText(detail, longestSecrets(secrets)).slice(0, FAILURE_DETAIL_MAX)
}

/**
 * One protocol event into the assistant tool rows.
 * The 41st event, and anything after it, collapse into a single truncated row.
 */
export function recordExternalActivity(
  sessions: ChatSession[],
  sessionId: string,
  event: ExternalActivity,
  secrets: readonly string[],
  budget: { count: number },
): void {
  budget.count += 1
  if (budget.count > EXTERNAL_ACTIVITY_CAP) {
    const omitted = budget.count - EXTERNAL_ACTIVITY_CAP
    appendToolEnd(sessions, sessionId, {
      id: 'truncated',
      name: 'truncated',
      isError: false,
      durationMs: 0,
      resultSummary: `${omitted} more events omitted`,
    })
    return
  }
  const ordered = longestSecrets(secrets)
  if (event.phase === 'start') {
    appendToolStart(sessions, sessionId, {
      id: event.id,
      name: event.name,
      args: redactValue(event.args, ordered),
    })
    return
  }
  appendToolEnd(sessions, sessionId, {
    id: event.id,
    name: event.name,
    isError: event.isError,
    durationMs: 0,
    resultSummary: redactText(event.result, ordered),
  })
}

function copyExternal(external: ChatExternalSlots | undefined): ChatExternalSlots | undefined {
  if (!external) return undefined
  const copy: ChatExternalSlots = {}
  for (const mode of ['grok', 'claude', 'codex'] as const) {
    const slot = external[mode]
    if (!slot) continue
    copy[mode] = { handle: slot.handle, cwd: slot.cwd }
  }
  return Object.keys(copy).length > 0 ? copy : undefined
}

function droppedExternalModes(text: string): ExternalCliMode[] {
  try {
    const raw = JSON.parse(text) as { external?: unknown }
    return parseExternalSlots(raw?.external).dropped
  } catch {
    return []
  }
}
import {
  buildTurnUndoPack,
  captureTurnBaseline,
  diffTurnNotes,
  isTurnNoteId,
  parseTurnUndoPack,
  planTurnUndo,
  serializeTurnUndoPack,
  TURN_BODY_FILE_BYTES,
  turnPackHasUndo,
  turnPackListPrefix,
  turnPackPath,
  turnPackRemovePaths,
  turnPacksToDelete,
  type TurnActivityRow,
  type TurnBaseline,
  type TurnBaselineNote,
} from './chat-turn-diff'
import { chatSystemPrompt, chatVaultHost } from './chat-vault-host'
import { chatMemoryHostKeyed } from './chat-memory-host'
import { CHAT_MEMORY_WORK_ERROR, ChatMemoryDistiller } from './chat-memory-distill'
import { resolveAppDataStore } from '../platform/app-data'
import { configuredAgentCommand, probeConfiguredAgent, resolveAgentProcessHost } from '../platform/agent-process'
import { closeOtherOverlays } from '../platform/overlays'
import { hostFetch } from '../platform/host-fetch'
import { isDesktopRuntime } from '../platform/runtime'
import { SettingsService } from '../settings/settings.service'
import { TabsService } from '../notes/tabs.service'
import { VaultService } from '../vault/vault.service'
import { hasDiskConflict, rememberDiskConflict } from '../vault/vault-refresh'
import { agentExecutableCommand } from '@stride/platform'

/**
 * The CLI session holds a process transport. It stays off the Service so the
 * reactive proxy does not wrap the stdio handle or the protocol client's maps.
 */
const heldExternalAgents = new WeakMap<object, {
  key: string
  session: ExternalAgentSession
  /** `configuredAgentCommand` at spawn. Stays off the Service. */
  spawnedCommand: string
}>()

const EXEC_PROBE_MS = 30_000

interface ExternalExecSnapshot {
  mode: ExternalCliMode
  found: boolean
  resolved: string
  command: string
}

const externalExecCache = new Map<string, { at: number; value: ExternalExecSnapshot }>()
const externalExecInflight = new Map<string, Promise<void>>()
let externalExecEpoch = 0

function execCacheKey(mode: string, command: string): string {
  return `${mode}\0${command}`
}

/** True only when the held mode's configured command differs from the command it spawned with. */
export function shouldDropHeldExecutable(
  held: { mode: ExternalCliMode; spawnedCommand: string } | null,
  executables: Partial<Record<ExternalCliMode, string | null>> | null | undefined,
): boolean {
  if (!held) return false
  return agentExecutableCommand(held.mode, executables?.[held.mode]) !== held.spawnedCommand
}

function isSpawnMissing(error: unknown): boolean {
  if (error instanceof ExternalAgentError) return error.failure === 'missing'
  if (!error || typeof error !== 'object' || !('code' in error)) return false
  return (error as { code?: unknown }).code === 'ENOENT'
}

interface VaultTurnState {
  snapshots: Map<string, string>
  created: Set<string>
  tombstones: Map<string, string>
  moved: Set<string>
}

const vaultTurnHolders = new WeakMap<object, { current: VaultTurnState | null }>()

function vaultTurnHolder(owner: object): { current: VaultTurnState | null } {
  let holder = vaultTurnHolders.get(owner)
  if (!holder) {
    holder = { current: null }
    vaultTurnHolders.set(owner, holder)
  }
  return holder
}

function emptyVaultTurn(): VaultTurnState {
  return {
    snapshots: new Map(),
    created: new Set(),
    tombstones: new Map(),
    moved: new Set(),
  }
}

/** Ids a Power shell pack must not undo. External packs do not use this set. */
function powerTurnExcludeIds(state: VaultTurnState | null): Set<string> {
  if (!state) return new Set()
  return new Set<string>([...state.snapshots.keys(), ...state.tombstones.keys(), ...state.moved])
}

interface PendingTurnUndo {
  sessionId: string
  messageId: string
  /** Power shell packs exclude structured write, delete, and move ids. */
  power: boolean
  baseline: TurnBaseline
}

function isAbsoluteCwd(value: string): boolean {
  return value.startsWith('/') || value.startsWith('\\\\') || /^[A-Za-z]:[\\/]/.test(value)
}

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
  /** Last probe for the selected external executable. Null while unchecked. */
  externalExec: ExternalExecSnapshot | null = null
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
  /** Assistant message ids whose turn pack has an undoable note. The panel reads this. */
  undoableTurnIds: string[] = []
  /** Assistant message ids whose last undo left a changed create in place. */
  undoSkippedTurnIds: string[] = []
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
    if (isExternalAgentMode(this.vault.agentMode)) return
    if (!this.settings.form.llmConfigs.some((config) => config.id === id)) return
    this.modelId = id
  }

  /** True when this host can spawn Grok, Claude Code, or Codex. */
  get externalAgentsAvailable(): boolean {
    return resolveAgentProcessHost().available
  }

  /**
   * Missing executable for the current mode.
   * Unchecked (no cached probe) stays false so a slow probe cannot block send.
   */
  get externalSendBlocked(): boolean {
    const mode = this.vault.agentMode
    if (!isExternalAgentMode(mode)) return false
    const command = configuredAgentCommand(mode)
    const exec = this.externalExec
    if (!exec || exec.mode !== mode || exec.command !== command) return false
    return !exec.found
  }

  /** Probe the selected CLI. No-op in the browser and when the host cannot spawn. */
  refreshExternalExec(): Promise<void> {
    if (!this.externalAgentsAvailable || !isDesktopRuntime()) return Promise.resolve()
    const mode = this.vault.agentMode
    if (!isExternalAgentMode(mode)) return Promise.resolve()
    const command = configuredAgentCommand(mode)
    const key = execCacheKey(mode, command)
    const cached = externalExecCache.get(key)
    if (cached && Date.now() - cached.at < EXEC_PROBE_MS) {
      this.publishExternalExec(cached.value)
      return Promise.resolve()
    }
    const pending = externalExecInflight.get(key)
    if (pending) return pending
    const epoch = externalExecEpoch
    const task = this.probeExternalExec(mode, command, key, epoch).finally(() => {
      if (externalExecInflight.get(key) === task) externalExecInflight.delete(key)
    })
    externalExecInflight.set(key, task)
    return task
  }

  /** Settings save: forget probed commands and drop the process only when its command changed. */
  onExecutableSettingsSaved() {
    externalExecEpoch += 1
    externalExecCache.clear()
    const executables = this.settings.form.agent?.executables
    const held = heldExternalAgents.get(raw(this) as object)
    const shown = this.externalExec
    if (shown && shown.command !== agentExecutableCommand(shown.mode, executables?.[shown.mode])) {
      this.externalExec = null
    }
    if (shouldDropHeldExecutable(
      held ? { mode: held.session.mode, spawnedCommand: held.spawnedCommand } : null,
      executables,
    )) {
      this.dropExternalAgent()
    }
    void this.refreshExternalExec()
  }

  private async probeExternalExec(mode: ExternalCliMode, command: string, key: string, epoch: number) {
    const cachedFound = externalExecCache.get(key)?.value.found
    const shown = this.externalExec
    const priorFound = cachedFound ?? (shown && shown.mode === mode && shown.command === command ? shown.found : undefined)
    let result: { found: boolean; resolved: string }
    try {
      const probed = await probeConfiguredAgent(mode, command)
      if (!probed) return
      result = probed
    } catch {
      return
    }
    if (epoch !== externalExecEpoch) return
    const value: ExternalExecSnapshot = {
      mode,
      command,
      found: result.found,
      resolved: result.found ? result.resolved : '',
    }
    externalExecCache.set(key, { at: Date.now(), value })
    this.publishExternalExec(value)
    if (priorFound === true && !result.found) this.dropHeldCommand(mode, command)
  }

  private publishExternalExec(value: ExternalExecSnapshot) {
    const mode = this.vault.agentMode
    if (!isExternalAgentMode(mode) || value.mode !== mode || value.command !== configuredAgentCommand(mode)) return
    this.externalExec = value
  }

  private dropHeldCommand(mode: ExternalCliMode, command: string) {
    const held = heldExternalAgents.get(raw(this) as object)
    if (!held || held.session.mode !== mode || held.spawnedCommand !== command) return
    this.dropExternalAgent()
  }

  private noteMissingExecutable(mode: ExternalCliMode, command: string) {
    externalExecEpoch += 1
    externalExecCache.delete(execCacheKey(mode, command))
    if (this.vault.agentMode !== mode || configuredAgentCommand(mode) !== command) return
    this.externalExec = { mode, found: false, resolved: '', command }
  }

  /** Kill the CLI held for this chat. The next external send starts a fresh process. */
  dropExternalAgent() {
    const owner = raw(this) as object
    const held = heldExternalAgents.get(owner)
    heldExternalAgents.delete(owner)
    if (held) void held.session.stop()
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
    this.dropExternalAgent()
    this.session = blankChatSession(newSessionId())
    this.error = ''
    this.clearTurnUndoFlags()
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
    this.dropExternalAgent()
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
    this.clearTurnUndoFlags()
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
      this.dropExternalAgent()
      // Vault switch trigger (design §6.1): the staged session just ended.
      if (this.session.messages.length > 0 && this.vaultKeyLoaded) {
        this.requestDistill(this.vaultKeyLoaded, this.session.id)
      }
      this.session = blankChatSession(newSessionId())
      this.error = ''
      this.clearTurnUndoFlags()
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
    this.dropExternalAgent()
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
      const external = copyExternal(file.external)
      const externalDropped = text ? droppedExternalModes(text) : []
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
        ...(external ? { external } : {}),
        ...(externalDropped.length > 0 ? { externalDropped } : {}),
      }
      this.error = ''
      this.historyOpen = false
      await this.loadTurnUndoFlags(vaultKey, this.session)
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
        // remove() deletes one file. Never pass the directory prefix itself.
        const packs = turnPackRemovePaths(await store.list(turnPackListPrefix(vaultKey, id)))
        for (const path of packs) await store.remove(path)
      } catch {
        // Deletion failures degrade silently; the entry just stays.
      }
    }
    this.metas = this.metas.filter((meta) => meta.id !== id)
    if (this.session.id === id && !this.running) {
      this.dropExternalAgent()
      this.session = blankChatSession(newSessionId())
      this.error = ''
      this.clearTurnUndoFlags()
    }
  }

  private vaultTools() {
    const vault = this.vault
    const mode = vault.agentMode === 'power' ? 'power' : 'safe'
    const id = `${vault.activeVaultId || 'none'}:${vault.agentMode}`
    if (!this.vaultToolSet || this.vaultToolSet.id !== id) {
      this.vaultToolSet = {
        id,
        tools: toolsForAgentMode(vaultTools(chatVaultHost(vault), vaultTurnHolder(raw(this) as object)), mode),
      }
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
    if (!text || this.running || this.externalSendBlocked) return
    if (isExternalAgentMode(this.vault.agentMode)) {
      await this.sendExternal(text)
      return
    }
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
    if (this.vault.agentMode === 'power') {
      vaultTurnHolder(raw(this) as object).current = emptyVaultTurn()
    }
    const ts = new Date().toISOString()
    session.messages.push({ id: newChatMessageId(), role: 'user', text, thinking: '', tools: [], ts })
    session.messages.push({ id: newChatMessageId(), role: 'assistant', text: '', thinking: '', tools: [], ts })
    this.running = true
    const controller = new AbortController()
    this.controller = controller
    const assistantId = session.messages[session.messages.length - 1]?.id ?? ''
    const undo = this.vault.agentMode === 'power' ? await this.beginTurnUndo(session, assistantId, true) : null
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
      if (undo) await this.finishTurnUndo(session, undo)
      this.running = false
      this.controller = null
      // Done, aborted, and failed turns all persist; this is the data-safety guarantee.
      await this.persist(session, vaultKey)
    }
  }

  /**
   * Grok, Claude Code, and Codex. Skips the built-in model loop and any Settings LLM config.
   * The CLI keeps its own default model: this path never sends a model override.
   */
  private async sendExternal(text: string) {
    const host = resolveAgentProcessHost()
    if (!host.available) {
      this.error = EXTERNAL_AGENT_CODES.unavailable
      return
    }
    await this.ensureLoaded()
    const mode = this.vault.agentMode
    if (!isExternalAgentMode(mode)) return
    const cwd = this.vault.fs?.rootLabel ?? ''
    if (!isAbsoluteCwd(cwd)) {
      this.error = EXTERNAL_AGENT_CODES.unavailable
      return
    }
    const vaultKey = this.currentVaultKey()
    const session = this.session
    this.error = ''
    this.memoryError = ''
    this.draft = ''
    if (session.status === 'closed') session.status = 'active'
    if (session.title === 'New') session.title = sessionTitleFromText(text) || 'New'
    const ts = new Date().toISOString()
    session.messages.push({ id: newChatMessageId(), role: 'user', text, thinking: '', tools: [], ts })
    session.messages.push({ id: newChatMessageId(), role: 'assistant', text: '', thinking: '', tools: [], ts })
    this.running = true
    const controller = new AbortController()
    this.controller = controller
    const assistantId = session.messages[session.messages.length - 1]?.id ?? ''
    const undo = await this.beginTurnUndo(session, assistantId, false)
    const slotRejected = session.externalDropped?.includes(mode) === true
    const activity = { count: 0 }
    const preface = buildResumePreface(session.messages.slice(0, -2).map((message) => ({
      role: message.role,
      text: message.text,
      tools: message.tools.map((tool) => ({ name: tool.name })),
    })), longestSecrets(this.settings.configuredSecretValues()))
    try {
      const agent = this.externalSession(mode, cwd)
      await agent.prompt(text, controller.signal, (delta) => {
        appendAssistantDelta([session], session.id, 'text', delta)
      }, (event) => {
        recordExternalActivity([session], session.id, event, this.settings.configuredSecretValues(), activity)
      }, {
        slot: session.external?.[mode] ?? null,
        slotRejected,
        preface,
        onHandle: (handle) => this.rememberExternalHandle(session, vaultKey, mode, handle, cwd),
        onDropSlot: () => this.dropExternalHandle(session, mode),
      })
      if (controller.signal.aborted) {
        this.error = agent.reusable ? EXTERNAL_AGENT_CODES.stopped : EXTERNAL_AGENT_CODES.stoppedResume
      } else if (agent.resumeFailed) {
        this.error = RESUME_FAILED
      }
      if (slotRejected) this.clearDroppedMode(session, mode)
    } catch (error) {
      const held = heldExternalAgents.get(raw(this) as object)
      const spawned = held?.session.mode === mode ? held.spawnedCommand : ''
      const missing = isSpawnMissing(error)
      this.dropExternalAgent()
      if (missing && spawned) this.noteMissingExecutable(mode, spawned)
      if (controller.signal.aborted || (error instanceof ExternalAgentError && error.failure === 'abort')) {
        this.error = EXTERNAL_AGENT_CODES.abort
      } else if (error instanceof ExternalAgentError) {
        this.error = error.failure === 'failed' && error.detail
          ? redactExternalFailure(error.detail, this.settings.configuredSecretValues())
          : error.message
      } else {
        this.error = EXTERNAL_AGENT_CODES.failed
      }
    } finally {
      if (undo) await this.finishTurnUndo(session, undo)
      this.running = false
      this.controller = null
      await this.persist(session, vaultKey)
    }
  }

  private externalSession(mode: 'grok' | 'claude' | 'codex', cwd: string): ExternalAgentSession {
    const owner = raw(this) as object
    const key = `${this.vault.activeVaultId}:${this.session.id}:${mode}`
    const command = configuredAgentCommand(mode)
    const held = heldExternalAgents.get(owner)
    if (
      held &&
      held.key === key &&
      held.session.mode === mode &&
      held.spawnedCommand === command &&
      held.session.cwd === cwd
    ) {
      return held.session
    }
    this.dropExternalAgent()
    const session = new ExternalAgentSession(resolveAgentProcessHost(), mode, cwd)
    heldExternalAgents.set(owner, { key, session, spawnedCommand: command })
    return session
  }

  /** Store a CLI id after the user message is already on the session. Same id and cwd is a no-op. */
  private rememberExternalHandle(
    session: ChatSession,
    vaultKey: string,
    mode: ExternalCliMode,
    handle: string,
    cwd: string,
  ) {
    if (!handle) return
    const current = session.external?.[mode]
    if (current?.handle === handle && current.cwd === cwd) return
    session.external = copyExternal({ ...session.external, [mode]: { handle, cwd } })
    void this.persist(session, vaultKey)
  }

  private dropExternalHandle(session: ChatSession, mode: ExternalCliMode) {
    if (!session.external?.[mode]) return
    const next: ChatExternalSlots = { ...session.external }
    delete next[mode]
    session.external = copyExternal(next)
  }

  private clearDroppedMode(session: ChatSession, mode: ExternalCliMode) {
    if (!session.externalDropped?.includes(mode)) return
    const next = session.externalDropped.filter((item) => item !== mode)
    session.externalDropped = next.length > 0 ? next : undefined
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
      const external = copyExternal(session.external)
      const file: ChatSessionFile = {
        format: 1,
        id: session.id,
        messages: session.messages.map(toSessionMessage),
        // Tool results are capped first, then system messages are stripped:
        // the persisted transcript must be replay-safe and bounded.
        transcript: stripSystemMessages(truncateTranscript(session.transcript)),
        memory: { ...session.memory },
        ...(external ? { external } : {}),
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

  /**
   * Restore note files from one turn pack.
   * Dirty notes and unresolved disk conflicts are not written; the editor banner is the surface.
   * A created note whose bytes changed since the turn is left in place.
   */
  async undoTurn(messageId: string): Promise<void> {
    if (this.running || !messageId) return
    const vaultKey = this.currentVaultKey()
    if (!vaultKey) return
    let rawPack: string | null = null
    try {
      const { store } = await resolveAppDataStore()
      rawPack = await store.readText(turnPackPath(vaultKey, this.session.id, messageId))
    } catch {
      return
    }
    const pack = rawPack ? parseTurnUndoPack(rawPack) : null
    if (!pack || !turnPackHasUndo(pack)) return
    const blocked = new Set<string>([
      ...this.vault.unsavedNoteIds(),
      ...this.vault.diskConflicts.map((item) => item.id),
    ])
    const current = await this.collectTurnNotes('current')
    const plan = planTurnUndo(
      pack,
      current.map((note) => ({ id: note.id, serialized: note.serialized, note: true })),
      blocked,
    )
    for (const step of plan.steps) {
      try {
        if (step.op === 'write') await this.vault.writeExternalNote(step.id, step.bytes)
        else if (step.op === 'delete') await this.vault.deleteNotes([step.id])
        else if (step.op === 'openBanner' && !hasDiskConflict(this.vault, step.id)) await this.retainDiskConflict(step.id)
      } catch {
        // One note failing does not stop the rest of the pack.
      }
    }
    this.setUndoFlag(this.undoSkippedTurnIds, messageId, plan.skippedIds.length > 0, (next) => {
      this.undoSkippedTurnIds = next
    })
  }

  private clearTurnUndoFlags() {
    if (this.undoableTurnIds.length > 0) this.undoableTurnIds = []
    if (this.undoSkippedTurnIds.length > 0) this.undoSkippedTurnIds = []
  }

  private setUndoFlag(
    current: readonly string[],
    messageId: string,
    on: boolean,
    assign: (next: string[]) => void,
  ) {
    const hasId = current.includes(messageId)
    if (on && !hasId) assign([...current, messageId])
    else if (!on && hasId) assign(current.filter((id) => id !== messageId))
  }

  private async loadTurnUndoFlags(vaultKey: string, session: ChatSession): Promise<void> {
    try {
      const { store } = await resolveAppDataStore()
      const listed = turnPackRemovePaths(await store.list(turnPackListPrefix(vaultKey, session.id)))
      const known = new Set(session.messages.map((message) => message.id).filter((id): id is string => Boolean(id)))
      const undoable: string[] = []
      for (const path of listed) {
        const text = await store.readText(path)
        const pack = text ? parseTurnUndoPack(text) : null
        if (!pack || !turnPackHasUndo(pack) || !known.has(pack.turnId) || undoable.includes(pack.turnId)) continue
        undoable.push(pack.turnId)
      }
      if (this.session !== session) return
      this.undoableTurnIds = undoable
      this.undoSkippedTurnIds = []
    } catch {
      if (this.session === session) this.clearTurnUndoFlags()
    }
  }

  /** Snapshot before the prompt. Failures skip undo for the turn instead of blocking send. */
  private async beginTurnUndo(
    session: ChatSession,
    messageId: string,
    power: boolean,
  ): Promise<PendingTurnUndo | null> {
    if (!messageId) return null
    try {
      const notes = await this.collectTurnNotes('baseline')
      const activeId = this.vault.activeId || null
      const openTabIds = has(TabsService) ? resolve(TabsService).tabs.map((tab) => tab.noteId) : []
      return {
        sessionId: session.id,
        messageId,
        power,
        baseline: captureTurnBaseline({ notes, openTabIds, activeId }),
      }
    } catch {
      return null
    }
  }

  /** Success, stop, and failure all record the note diff. Pack bytes stay unredacted. */
  private async finishTurnUndo(session: ChatSession, pending: PendingTurnUndo): Promise<void> {
    try {
      const current = await this.collectTurnNotes('current')
      const diff = diffTurnNotes(pending.baseline, current)
      this.appendTurnFileRows(session, diff.rows)
      const vaultKey = this.currentVaultKey()
      if (!vaultKey) return
      const excludeIds = pending.power ? powerTurnExcludeIds(vaultTurnHolder(raw(this) as object).current) : undefined
      const pack = buildTurnUndoPack(diff, {
        vaultKey,
        sessionId: pending.sessionId,
        turnId: pending.messageId,
        writtenAt: new Date().toISOString(),
        ...(excludeIds && excludeIds.size > 0 ? { excludeIds } : {}),
      })
      await this.writeTurnPack(vaultKey, pending.sessionId, pack)
      if (this.session === session) {
        this.setUndoFlag(this.undoableTurnIds, pending.messageId, turnPackHasUndo(pack), (next) => {
          this.undoableTurnIds = next
        })
      }
    } catch {
      // Undo bookkeeping must not break the turn.
    }
  }

  private appendTurnFileRows(session: ChatSession, rows: readonly TurnActivityRow[]) {
    const secrets = longestSecrets(this.settings.configuredSecretValues())
    for (const row of rows) {
      // Protocol events already use id `truncated`. Keep the file overflow row distinct.
      const id = row.id === 'truncated' ? 'file:truncated' : row.id
      if (row.name === 'file') {
        appendToolStart([session], session.id, {
          id,
          name: row.name,
          args: redactValue(row.args, secrets),
        })
      }
      appendToolEnd([session], session.id, {
        id,
        name: row.name,
        isError: false,
        durationMs: 0,
        resultSummary: redactText(row.result, secrets),
      })
    }
  }

  private async writeTurnPack(vaultKey: string, sessionId: string, pack: ReturnType<typeof buildTurnUndoPack>): Promise<void> {
    const { store } = await resolveAppDataStore()
    await store.writeText(turnPackPath(vaultKey, sessionId, pack.turnId), serializeTurnUndoPack(pack))
    const listed = turnPackRemovePaths(await store.list(turnPackListPrefix(vaultKey, sessionId)))
    const ordered: { path: string; writtenAt: string }[] = []
    for (const path of listed) {
      const text = await store.readText(path)
      const parsed = text ? parseTurnUndoPack(text) : null
      ordered.push({ path, writtenAt: parsed?.writtenAt ?? '' })
    }
    ordered.sort((left, right) => left.writtenAt.localeCompare(right.writtenAt) || left.path.localeCompare(right.path))
    for (const stale of turnPacksToDelete(ordered.map((item) => item.path))) await store.remove(stale)
  }

  /**
   * Notes for one baseline or end-of-turn diff.
   * Dirty and conflicted notes are read from disk (the module drops bodies over 128KiB).
   * Clean notes use `serializeNote` while their stored mtime still matches the file.
   */
  private async collectTurnNotes(scope: 'baseline' | 'current'): Promise<TurnBaselineNote[]> {
    const vault = this.vault
    const memory = new Map<string, StrideNote>()
    for (const note of raw(vault.notes) as readonly StrideNote[]) {
      if (!isTurnNoteId(note.id) || memory.has(note.id)) continue
      memory.set(note.id, note)
    }
    const dirty = vault.unsavedNoteIds()
    const conflicted = new Set(vault.diskConflicts.map((item) => item.id))
    let listed: Set<string> | null = null
    if (scope === 'current' && vault.fs) {
      try {
        listed = new Set()
        for (const file of await listNoteFiles(vault.fs)) {
          const id = noteIdFromPath(file)
          if (isTurnNoteId(id)) listed.add(id)
        }
      } catch {
        listed = null
      }
    }
    const ids = new Set<string>(memory.keys())
    if (listed) {
      for (const id of listed) ids.add(id)
    }
    const notes: TurnBaselineNote[] = []
    for (const id of ids) {
      const note = memory.get(id)
      const needsDisk = dirty.has(id) || conflicted.has(id) || !note
      const row = await this.readTurnNote(id, note, needsDisk, listed, scope)
      if (row) notes.push(row)
    }
    return notes
  }

  private async readTurnNote(
    id: string,
    memory: StrideNote | undefined,
    needsDisk: boolean,
    listed: Set<string> | null,
    scope: 'baseline' | 'current',
  ): Promise<TurnBaselineNote | null> {
    const vault = this.vault
    const fs = vault.fs
    const stored = vault.noteMtimes[id]
    if (!fs) {
      if (!memory || needsDisk) return null
      return { id, serialized: serializeNote(memory), mtime: stored ?? 0 }
    }
    if (scope === 'current' && listed && !listed.has(id)) return null
    let file: { size: number; mtimeMs: number } | null = null
    try {
      const info = await fs.stat(notePath(id))
      if (info?.kind === 'file') file = info
    } catch {
      file = null
    }
    const trustMemory = Boolean(memory) && !needsDisk && (
      scope === 'baseline' || (file != null && typeof stored === 'number' && stored === file.mtimeMs)
    )
    if (trustMemory && memory) {
      return { id, serialized: serializeNote(memory), mtime: stored ?? file?.mtimeMs ?? 0 }
    }
    if (!file) return null
    try {
      const bytes = await fs.readBytes(notePath(id))
      // Hash the whole file. The pack keeps the body only when it is within 128KiB.
      if (bytes.byteLength > TURN_BODY_FILE_BYTES) return { id, serialized: bytes, mtime: file.mtimeMs }
      return { id, serialized: new TextDecoder().decode(bytes), mtime: file.mtimeMs }
    } catch {
      if (memory && !needsDisk) return { id, serialized: serializeNote(memory), mtime: stored ?? 0 }
      return null
    }
  }

  /** Open the existing disk-conflict banner for a dirty note undo must not overwrite. */
  private async retainDiskConflict(id: string): Promise<void> {
    const fs = this.vault.fs
    if (!fs || hasDiskConflict(this.vault, id)) return
    let info: { kind: string; size: number; mtimeMs: number } | null = null
    try {
      info = await fs.stat(notePath(id))
    } catch {
      info = null
    }
    const file = info?.kind === 'file' ? info : null
    if (!file) {
      rememberDiskConflict(this.vault, { id, mtimeMs: null, size: null, note: null, undoable: false })
      return
    }
    if (file.size > TURN_BODY_FILE_BYTES) {
      rememberDiskConflict(this.vault, { id, mtimeMs: file.mtimeMs, size: file.size, note: null, undoable: false })
      return
    }
    try {
      const bytes = await fs.readBytes(notePath(id))
      if (bytes.byteLength > TURN_BODY_FILE_BYTES) {
        rememberDiskConflict(this.vault, { id, mtimeMs: file.mtimeMs, size: file.size, note: null, undoable: false })
        return
      }
      const note = parseNote(new TextDecoder().decode(bytes), id)
      rememberDiskConflict(this.vault, { id, mtimeMs: file.mtimeMs, size: file.size, note, undoable: true })
    } catch {
      rememberDiskConflict(this.vault, { id, mtimeMs: file.mtimeMs, size: file.size, note: null, undoable: false })
    }
  }
}
