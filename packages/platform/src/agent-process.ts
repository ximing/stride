/**
 * Long-lived stdio process for an external coding agent.
 * The renderer speaks the CLI protocol. Only the host spawns the process.
 */

export const EXTERNAL_AGENT_MODES = ['grok', 'claude', 'codex'] as const

export type ExternalAgentMode = (typeof EXTERNAL_AGENT_MODES)[number]

export interface AgentSpawnSpec {
  command: string
  args: readonly string[]
}

/**
 * Argv Waka uses to schedule each CLI, without a model override.
 * Claude matches `claude -p --output-format stream-json --input-format stream-json --verbose`
 * plus the permission flags Waka always passes. Codex is `app-server --listen stdio://`.
 * Grok is `grok --no-auto-update agent --always-approve stdio`.
 */
export const EXTERNAL_AGENT_SPAWN: Record<ExternalAgentMode, AgentSpawnSpec> = {
  claude: {
    command: 'claude',
    args: [
      '-p',
      '--output-format',
      'stream-json',
      '--input-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'bypassPermissions',
      '--disallowedTools',
      'AskUserQuestion',
    ],
  },
  codex: {
    command: 'codex',
    args: ['app-server', '--listen', 'stdio://'],
  },
  grok: {
    command: 'grok',
    args: ['--no-auto-update', 'agent', '--always-approve', 'stdio'],
  },
}

export function isExternalAgentMode(value: string): value is ExternalAgentMode {
  return (EXTERNAL_AGENT_MODES as readonly string[]).includes(value)
}

/** A copy of the canonical argv. Callers must not append a model flag. */
export function agentSpawnSpec(mode: ExternalAgentMode): AgentSpawnSpec {
  const spec = EXTERNAL_AGENT_SPAWN[mode]
  return { command: spec.command, args: [...spec.args] }
}

/** A configured path wins. An empty or unset value keeps the bare command name. */
export function agentExecutableCommand(mode: ExternalAgentMode, configured: string | null | undefined): string {
  if (typeof configured !== 'string') return mode
  const trimmed = configured.trim()
  return trimmed || mode
}

export function spawnArgsOverrideModel(args: readonly string[]): boolean {
  return args.some((arg) => arg === '--model' || arg.startsWith('--model='))
}

/**
 * Fixed English rules for an external CLI. No secrets and no paths.
 * The Electron main process compares a Claude suffix to this string, so the renderer cannot swap in another prompt.
 */
export const VAULT_CLI_RULES =
  'This directory is a Stride vault. A note is a *.stride.json file. Its doc field is TipTap JSON. Do not flatten a note into a plain-text paragraph. Do not rewrite *.stride.json with a shell or a text editor. If you change a note, edit the TipTap nodes inside doc and keep format, title, type, and properties. Do not delete or rename note files unless the user asked. Never write API keys into the vault.'

/** Claude resume id passed as one argv element. Same character set as a stored Claude handle. */
const CLAUDE_RESUME_HANDLE = /^[A-Za-z0-9._:-]{1,128}$/

/**
 * Full argv to spawn, or null when the list is not allowlisted.
 * Claude may append `--append-system-prompt`, the exact rules, and an optional `--resume` handle.
 * Codex and Grok stay on the canonical list. The returned array is the full validated argv.
 */
export function acceptedAgentArgv(mode: ExternalAgentMode, args: readonly string[]): string[] | null {
  if (spawnArgsOverrideModel(args)) return null
  const canonical = EXTERNAL_AGENT_SPAWN[mode].args
  if (args.length < canonical.length) return null
  for (let index = 0; index < canonical.length; index += 1) {
    if (args[index] !== canonical[index]) return null
  }
  const extra = args.slice(canonical.length)
  if (mode !== 'claude') return extra.length === 0 ? [...args] : null
  if (extra.length === 0) return [...args]
  if (extra[0] !== '--append-system-prompt' || extra[1] !== VAULT_CLI_RULES) return null
  if (extra.length === 2) return [...args]
  if (extra.length === 4 && extra[2] === '--resume' && CLAUDE_RESUME_HANDLE.test(extra[3] ?? '')) return [...args]
  return null
}

export interface AgentProcessSpawn {
  command: string
  args: readonly string[]
  cwd: string
}

export interface AgentProcessExit {
  code: number | null
  error?: string
}

/** One spawned CLI. `write` sends stdin bytes. Stdout arrives through `onData`. */
export interface AgentProcessTransport {
  write(data: string): Promise<void>
  onData(listener: (chunk: string) => void): () => void
  onExit(listener: (info: AgentProcessExit) => void): () => void
  kill(): Promise<void>
}

export interface AgentProcessHost {
  readonly available: boolean
  spawn(spec: AgentProcessSpawn): Promise<AgentProcessTransport>
}

export function unavailableAgentProcessHost(): AgentProcessHost {
  return {
    available: false,
    spawn() {
      return Promise.reject(new Error('external-agent-unavailable'))
    },
  }
}
