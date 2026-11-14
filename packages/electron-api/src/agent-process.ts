import { electronBridge, type ElectronBridge, type ElectronDisposer } from './index.ts'

/** `agent:spawn` body. Arguments must be the canonical CLI argv with no model flag. */
export interface AgentSpawnRequest {
  command: string
  args: string[]
  cwd: string
}

/**
 * One `agent:event` payload. `stdout` uses `data`.
 * `exit` uses `code` and `message` (spawn error or a short stderr tail).
 */
export interface AgentEvent {
  id: string
  event: 'stdout' | 'exit'
  data?: string
  code?: number | null
  message?: string
}

function bridge(): ElectronBridge {
  return electronBridge()
}

export function onAgentEvent(listener: (payload: unknown) => void): ElectronDisposer {
  return bridge().on('agent:event', listener)
}

export async function spawnAgent(request: AgentSpawnRequest): Promise<string> {
  if (typeof request?.command !== 'string' || typeof request.cwd !== 'string' || !Array.isArray(request.args)) {
    throw new Error('Rejected invalid agent request')
  }
  if (request.args.some((arg) => typeof arg !== 'string')) throw new Error('Rejected invalid agent request')
  const id = await bridge().invoke('agent:spawn', {
    command: request.command,
    args: [...request.args],
    cwd: request.cwd,
  })
  if (typeof id !== 'string' || id.length === 0) throw new Error('Rejected invalid agent id')
  return id
}

export async function writeAgent(id: string, data: string): Promise<void> {
  if (typeof id !== 'string' || id.length === 0 || typeof data !== 'string') {
    throw new Error('Rejected invalid agent request')
  }
  await bridge().invoke('agent:write', { id, data })
}

export async function killAgent(id: string): Promise<void> {
  if (typeof id !== 'string' || id.length === 0) throw new Error('Rejected invalid agent request')
  await bridge().invoke('agent:kill', { id })
}

export interface AgentExecutablePaths {
  grok: string | null
  claude: string | null
  codex: string | null
}

function executablePath(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > 4096 || trimmed.includes('\0')) return null
  return trimmed
}

/** Absolute paths the main process found for Grok, Claude Code, and Codex. */
export async function whichAgents(): Promise<AgentExecutablePaths> {
  const value = await bridge().invoke('agent:which')
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Rejected invalid agent paths')
  const record = value as Record<string, unknown>
  return {
    grok: executablePath(record.grok),
    claude: executablePath(record.claude),
    codex: executablePath(record.codex),
  }
}

function isProbeMode(value: unknown): value is 'grok' | 'claude' | 'codex' {
  return value === 'grok' || value === 'claude' || value === 'codex'
}

/** Read-only lookup. Does not spawn, and does not change saved paths. */
export async function probeAgent(request: {
  command: string
  mode: 'grok' | 'claude' | 'codex'
}): Promise<{ found: boolean; resolved: string }> {
  if (!request || typeof request.command !== 'string' || !isProbeMode(request.mode)) {
    throw new Error('Rejected invalid agent request')
  }
  const value = await bridge().invoke('agent:probe', { command: request.command, mode: request.mode })
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Rejected invalid agent probe')
  const record = value as Record<string, unknown>
  const resolved = typeof record.resolved === 'string' ? record.resolved : ''
  return { found: record.found === true, resolved }
}
