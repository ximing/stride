import {
  agentSpawnSpec,
  VAULT_CLI_RULES,
  type AgentProcessHost,
  type AgentProcessTransport,
  type ExternalAgentMode,
} from '@stride/platform'
import { isClaudeCliHandle } from '../chat-session.ts'
import { ClaudeClient } from './claude.ts'
import { CodexClient } from './codex.ts'
import { asHandshakeError, classifySpawnError, ExternalAgentError } from './errors.ts'
import { GrokClient } from './grok.ts'
import type { ExternalActivity } from './rpc.ts'

export type { ExternalActivity }

export interface ExternalPromptOptions {
  /** Stored slot for this mode. Omitted when this mode has never had a handle. */
  slot?: { handle: string; cwd: string } | null
  /** Parse dropped this mode's slot. Preface and resume-failed, not a silent new session. */
  slotRejected?: boolean
  /** Prior Stride chat, already redacted. Applied only when this start cannot resume. */
  preface?: string
  /** CLI id to store. Not called when the existing slot must stay. */
  onHandle?: (handle: string) => void
  /** Delete this mode's slot before a fresh process replaces a failed resume. */
  onDropSlot?: () => void
}

/**
 * One CLI process for the current chat. A second prompt reuses the process while it is ready.
 * User cancel does not call `stop`. A killed process stays on this object with `reusable === false`.
 */
export class ExternalAgentSession {
  private transport: AgentProcessTransport | null = null
  private claude: ClaudeClient | null = null
  private codex: CodexClient | null = null
  private grok: GrokClient | null = null
  private ready = false

  constructor(
    private readonly host: AgentProcessHost,
    readonly mode: ExternalAgentMode,
    readonly cwd: string,
  ) {}

  /** True when the next prompt can reuse the process without a new handshake. */
  get reusable(): boolean {
    return this.ready
  }

  /**
   * True after the prompt that just returned had to start a fresh CLI.
   * A later prompt on the same process clears it and does not repeat the preface.
   */
  resumeFailed = false

  async prompt(
    text: string,
    signal: AbortSignal,
    onText: (delta: string) => void,
    onActivity?: (event: ExternalActivity) => void,
    options?: ExternalPromptOptions,
  ): Promise<void> {
    if (!this.host.available) throw new ExternalAgentError('unavailable', 'external agent host is unavailable')
    if (signal.aborted) throw new ExternalAgentError('abort', 'aborted')
    this.resumeFailed = false
    let outbound = text
    try {
      if (!this.ready) {
        const started = await this.start(signal, options)
        this.resumeFailed = started.resumeFailed
        if (started.preface && options?.preface) outbound = `${options.preface}\n\n${text}`
      }
      const outcome = this.mode === 'claude'
        ? await this.claude!.prompt(outbound, signal, onText, onActivity)
        : this.mode === 'codex'
          ? await this.codex!.prompt(outbound, signal, onText, onActivity)
          : await this.grok!.prompt(outbound, signal, onText, onActivity)
      if (outcome.killed) this.detachKilledProcess()
    } catch (error) {
      await this.stop()
      if (signal.aborted) throw new ExternalAgentError('abort', 'aborted')
      throw error
    }
  }

  /** The cancel path already killed the process. Keep this object so a later start can resume it. */
  private detachKilledProcess(): void {
    this.ready = false
    this.transport = null
    this.claude = null
    this.codex = null
    this.grok = null
  }

  async stop(): Promise<void> {
    const transport = this.transport
    this.transport = null
    this.claude = null
    this.codex = null
    this.grok = null
    this.ready = false
    if (transport) await transport.kill().catch(() => undefined)
  }

  private async start(signal: AbortSignal, options?: ExternalPromptOptions): Promise<{ preface: boolean; resumeFailed: boolean }> {
    const plan = planResume(this.mode, options?.slot, this.cwd, options?.slotRejected === true)
    if (plan.dropSlot) options?.onDropSlot?.()
    try {
      const id = await this.spawnHandshake(signal, plan.resumeHandle)
      if (!plan.keepSlot) options?.onHandle?.(id)
      this.ready = true
      return { preface: plan.preface, resumeFailed: plan.resumeFailed }
    } catch (error) {
      const hadProcess = this.transport !== null
      await this.stop()
      if (signal.aborted) throw new ExternalAgentError('abort', 'aborted')
      // Spawn never started a process. Do not pretend the resume RPC failed.
      if (!hadProcess) throw error instanceof ExternalAgentError ? error : classifySpawnError(error)
      if (!plan.resumeHandle) throw mapStartError(error)
      options?.onDropSlot?.()
      try {
        const id = await this.spawnHandshake(signal, null)
        options?.onHandle?.(id)
        this.ready = true
        return { preface: true, resumeFailed: true }
      } catch (retryError) {
        await this.stop()
        if (signal.aborted) throw new ExternalAgentError('abort', 'aborted')
        throw mapStartError(retryError)
      }
    }
  }

  private async spawnHandshake(signal: AbortSignal, resumeHandle: string | null): Promise<string> {
    const spec = agentSpawnSpec(this.mode)
    const args = [...spec.args]
    if (this.mode === 'claude') {
      args.push('--append-system-prompt', VAULT_CLI_RULES)
      if (resumeHandle) args.push('--resume', resumeHandle)
    }
    let transport: AgentProcessTransport
    try {
      transport = await this.host.spawn({ command: spec.command, args, cwd: this.cwd })
    } catch (error) {
      throw classifySpawnError(error)
    }
    this.transport = transport
    if (this.mode === 'claude') {
      this.claude = new ClaudeClient()
      return this.claude.start(transport, signal)
    }
    if (this.mode === 'codex') {
      this.codex = new CodexClient()
      return this.codex.start(transport, signal, resumeHandle ? { threadId: resumeHandle, cwd: this.cwd } : undefined)
    }
    this.grok = new GrokClient()
    // session/load stays unsent until its capability field is confirmed.
    return this.grok.start(transport, this.cwd, signal)
  }
}

interface ResumePlan {
  resumeHandle: string | null
  preface: boolean
  resumeFailed: boolean
  keepSlot: boolean
  dropSlot: boolean
}

function planResume(
  mode: ExternalAgentMode,
  slot: { handle: string; cwd: string } | null | undefined,
  cwd: string,
  slotRejected: boolean,
): ResumePlan {
  if (!slot?.handle) {
    if (slotRejected) {
      return { resumeHandle: null, preface: true, resumeFailed: true, keepSlot: false, dropSlot: false }
    }
    return { resumeHandle: null, preface: false, resumeFailed: false, keepSlot: false, dropSlot: false }
  }
  if (slot.cwd !== cwd) {
    return { resumeHandle: null, preface: true, resumeFailed: false, keepSlot: true, dropSlot: false }
  }
  if (mode === 'claude' && !isClaudeCliHandle(slot.handle)) {
    return { resumeHandle: null, preface: true, resumeFailed: true, keepSlot: false, dropSlot: true }
  }
  if (mode === 'grok') {
    return { resumeHandle: null, preface: true, resumeFailed: true, keepSlot: false, dropSlot: false }
  }
  return { resumeHandle: slot.handle, preface: false, resumeFailed: false, keepSlot: false, dropSlot: false }
}

function mapStartError(error: unknown): ExternalAgentError {
  if (error instanceof ExternalAgentError && error.failure === 'abort') {
    return new ExternalAgentError('handshake', error.detail || 'timed out')
  }
  return asHandshakeError(error)
}
