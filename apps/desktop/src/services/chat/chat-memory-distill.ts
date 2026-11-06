// Background memory work (design §6): distillation turns a finished session's
// undistilled transcript increment into long-term memory via a headless agent
// pass; curation cleans the store every Nth distillation or past the entry
// limits. All passes run one per vault key, share the memory host's write
// queue with chat turns, and never block the chat surface — failures only log
// and raise a one-shot panel line.

import {
  buildMemorySection,
  CURATE_MEMORY_PROMPT,
  DISTILL_MEMORY_PROMPT,
  distillableSlice,
  emptyMemoryIndex,
  memoryTools,
  parseSession,
  resolveLlm,
  serializeSession,
  shouldCurate,
  type ChatSessionFile,
  type ChatSessionMemoryCursor,
  type LlmConfig,
  type MemoryToolHost,
} from '@stride/core'
import type { AppDataStore } from '@stride/platform'
import { resolveAppDataStore } from '../platform/app-data'
import { hostFetch } from '../platform/host-fetch'
import { playChatTurn } from './chat-turn'

/** Stored in ChatService.memoryError; the panel translates it. */
export const CHAT_MEMORY_WORK_ERROR = 'memory-work-failed'

/** Model rounds for one memory pass; distillation is cheap, curation roams more. */
const DISTILL_MAX_TURNS = 16
const CURATE_MAX_TURNS = 24

export interface MemoryRuntime {
  provider: string
  model: string
  baseUrl: string
  apiKey: string
}

export interface ChatMemoryDistillerDeps {
  /** Memory model; null or incomplete skips silently (design §6.1). */
  runtime(): MemoryRuntime | null
  /** Dev-proxy rewrite shared with chat turns. */
  baseUrl(baseUrl: string): string
  /** Host per vault key; the caller caches instances so writes share one queue. */
  host(vaultKey: string): MemoryToolHost
  /** The staged session is mid-turn; its file may lag, so distillation defers. */
  sessionRunning(id: string): boolean
  /** Reflect an advanced cursor on the staged in-memory session. */
  cursorAdvanced(id: string, cursor: ChatSessionMemoryCursor): void
  /** Panel status line while any runner is active. */
  setBusy(busy: boolean): void
  /** One-shot panel error text; '' clears it. */
  setError(message: string): void
}

export class ChatMemoryDistiller {
  private readonly pending = new Map<string, string[]>()
  private readonly runners = new Map<string, Promise<void>>()
  private readonly controllers = new Map<string, AbortController>()
  private readonly scanned = new Set<string>()

  constructor(private readonly deps: ChatMemoryDistillerDeps) {}

  get busy(): boolean {
    return this.runners.size > 0
  }

  /** Enqueue a session for distillation and kick the vault's runner if idle. */
  request(vaultKey: string, sessionId: string): void {
    if (!vaultKey || !sessionId) return
    const queue = this.pending.get(vaultKey) ?? []
    if (!queue.includes(sessionId)) queue.push(sessionId)
    this.pending.set(vaultKey, queue)
    if (!this.runners.has(vaultKey)) {
      const run = this.run(vaultKey).finally(() => {
        this.runners.delete(vaultKey)
      })
      this.runners.set(vaultKey, run)
    }
  }

  /**
   * Startup pass (design §6.1): enqueue every persisted session with an
   * undistilled increment. Without a memory model there is nothing to run, so
   * the vault stays unscanned and a later ensureLoaded retries.
   */
  scan(vaultKey: string, sessionIds: string[]): void {
    if (!vaultKey || this.scanned.has(vaultKey)) return
    if (!this.deps.runtime()) return
    this.scanned.add(vaultKey)
    void this.scanDirty(vaultKey, sessionIds)
  }

  /** Abort the running pass; queued work stays pending for the next trigger. */
  cancel(vaultKey?: string): void {
    if (vaultKey) {
      this.controllers.get(vaultKey)?.abort()
      return
    }
    for (const controller of this.controllers.values()) controller.abort()
  }

  /** Test hook: drops scan bookkeeping and queued work between cases. */
  reset(): void {
    this.cancel()
    this.pending.clear()
    this.scanned.clear()
  }

  /** Test/observability hook: resolves when every active runner is done. */
  async whenSettled(): Promise<void> {
    await Promise.all([...this.runners.values()])
  }

  private take(vaultKey: string): string | null {
    const queue = this.pending.get(vaultKey)
    const next = queue?.shift() ?? null
    if (queue && queue.length === 0) this.pending.delete(vaultKey)
    return next
  }

  private requeueFront(vaultKey: string, sessionId: string): void {
    const queue = this.pending.get(vaultKey) ?? []
    queue.unshift(sessionId)
    this.pending.set(vaultKey, queue)
  }

  private async run(vaultKey: string): Promise<void> {
    this.deps.setBusy(true)
    const controller = new AbortController()
    this.controllers.set(vaultKey, controller)
    try {
      let sessionId = this.take(vaultKey)
      while (sessionId) {
        if (controller.signal.aborted) {
          // Cancelled: the rest of the queue waits for the next trigger.
          this.requeueFront(vaultKey, sessionId)
          break
        }
        // A session mid-turn persists again when the turn ends; distill it then.
        if (!this.deps.sessionRunning(sessionId)) {
          await this.distill(vaultKey, sessionId, controller.signal)
        }
        sessionId = this.take(vaultKey)
      }
    } finally {
      this.controllers.delete(vaultKey)
      this.deps.setBusy(this.runners.size > 1)
    }
  }

  private async scanDirty(vaultKey: string, sessionIds: string[]): Promise<void> {
    try {
      const { store } = await resolveAppDataStore()
      for (const id of sessionIds) {
        const text = await store.readText(`chats/${vaultKey}/${id}.json`)
        const file = text ? parseSession(text) : null
        if (file && file.transcript.length > file.memory.distilledUpTo) this.request(vaultKey, id)
      }
    } catch (error) {
      console.warn('stride memory: startup scan failed', error)
    }
  }

  private model(): { config: LlmConfig; resolved: ReturnType<typeof resolveLlm> } | null {
    const runtime = this.deps.runtime()
    if (!runtime?.apiKey || !runtime.model || !runtime.baseUrl) return null
    const config: LlmConfig = {
      id: 'memory',
      name: runtime.provider,
      provider: runtime.provider,
      model: runtime.model,
      baseUrl: this.deps.baseUrl(runtime.baseUrl),
      apiKey: runtime.apiKey,
      isDefault: true,
    }
    return { config, resolved: resolveLlm(config) }
  }

  private play(model: { resolved: ReturnType<typeof resolveLlm> }, input: {
    systemPrompt: string
    prompt: string
    tools: ReturnType<typeof memoryTools>
    maxTurns: number
    signal: AbortSignal
  }) {
    return playChatTurn({
      model: model.resolved.model,
      apiKey: model.resolved.apiKey,
      systemPrompt: input.systemPrompt,
      prompt: input.prompt,
      tools: input.tools,
      maxTurns: input.maxTurns,
      signal: input.signal,
      streamFn: (inner, context, options) =>
        model.resolved.models.streamSimple(inner, context, {
          ...options,
          apiKey: model.resolved.apiKey,
          fetch: hostFetch,
        }),
      // Headless: the transcript carries everything; nothing renders live.
      onText: () => {},
      onThinking: () => {},
    })
  }

  private async distill(vaultKey: string, sessionId: string, signal: AbortSignal): Promise<void> {
    const model = this.model()
    if (!model) return
    try {
      const { store } = await resolveAppDataStore()
      const path = `chats/${vaultKey}/${sessionId}.json`
      const text = await store.readText(path)
      const file = text ? parseSession(text) : null
      if (!file) return
      const increment = distillableSlice(file.transcript, file.memory.distilledUpTo)
      const host = this.deps.host(vaultKey)
      if (increment.length === 0) {
        // Only an aborted tail was new: advance the cursor without a model call.
        if (file.memory.distilledUpTo !== file.transcript.length) {
          await this.advanceCursor(store, path, file, sessionId)
        }
        return
      }
      const [project, globalScope] = await Promise.all([host.readIndex('project'), host.readIndex('global')])
      const section = buildMemorySection({ project, global: globalScope })
      const result = await this.play(model, {
        systemPrompt: section ? `${DISTILL_MEMORY_PROMPT}\n\n${section}` : DISTILL_MEMORY_PROMPT,
        prompt: JSON.stringify(increment),
        tools: memoryTools(host, { source: { sessionId }, actor: 'distill' }),
        maxTurns: DISTILL_MAX_TURNS,
        signal,
      })
      // A cancelled pass leaves the cursor alone so the next trigger retries.
      if (result.aborted) return
      await this.advanceCursor(store, path, file, sessionId)
      this.deps.setError('')
      const stamp = new Date().toISOString()
      const index = await host.readIndex('project')
      const counted = {
        ...(index ?? emptyMemoryIndex(stamp)),
        updatedAt: stamp,
        distillCount: (index?.distillCount ?? 0) + 1,
      }
      await host.writeIndex('project', counted)
      if (shouldCurate('project', counted) || shouldCurate('global', await host.readIndex('global'))) {
        await this.curate(model, host, signal)
      }
    } catch (error) {
      if (signal.aborted) return
      console.warn('stride memory: distillation failed', error)
      this.deps.setError(CHAT_MEMORY_WORK_ERROR)
    }
  }

  /** Persist the new cursor and mirror it onto the staged in-memory session. */
  private async advanceCursor(
    store: AppDataStore,
    path: string,
    file: ChatSessionFile,
    sessionId: string,
  ): Promise<void> {
    const cursor: ChatSessionMemoryCursor = {
      distilledUpTo: file.transcript.length,
      lastDistillAt: new Date().toISOString(),
    }
    await store.writeText(path, serializeSession({ ...file, memory: cursor }))
    this.deps.cursorAdvanced(sessionId, cursor)
  }

  private async curate(
    model: { resolved: ReturnType<typeof resolveLlm> },
    host: MemoryToolHost,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      const [project, globalScope] = await Promise.all([host.readIndex('project'), host.readIndex('global')])
      await this.play(model, {
        systemPrompt: CURATE_MEMORY_PROMPT,
        prompt: JSON.stringify({ project, global: globalScope }),
        tools: memoryTools(host, { actor: 'curate' }),
        maxTurns: CURATE_MAX_TURNS,
        signal,
      })
    } catch (error) {
      if (signal.aborted) return
      console.warn('stride memory: curation failed', error)
      this.deps.setError(CHAT_MEMORY_WORK_ERROR)
    }
  }
}
