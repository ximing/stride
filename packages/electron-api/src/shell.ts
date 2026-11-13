import { electronBridge, type ElectronBridge, type ElectronDisposer } from './index.ts'

/** `shell:spawn` body. The main process owns the interpreter, env, and limits. */
export interface ShellSpawnRequest {
  command: string
  cwd: string
  /** Milliseconds. Omit when the caller did not set a timeout. */
  timeoutMs?: number
}

/**
 * One `shell:event` payload. Every event carries the session `id`.
 * `stdout` and `stderr` use `data`. `error` uses `message`.
 * `exit` uses `code`, `truncated`, and `reason` (`exit` | `cap` | `timeout` | `cancel`).
 */
export interface ShellEvent {
  id: string
  event: 'started' | 'stdout' | 'stderr' | 'error' | 'exit'
  data?: string
  message?: string
  code?: number | null
  truncated?: boolean
  reason?: string
}

function bridge(): ElectronBridge {
  return electronBridge()
}

function requestBody(request: ShellSpawnRequest): ShellSpawnRequest {
  if (typeof request?.command !== 'string' || typeof request.cwd !== 'string') {
    throw new Error('Rejected invalid shell request')
  }
  const body: ShellSpawnRequest = { command: request.command, cwd: request.cwd }
  if (request.timeoutMs !== undefined) {
    if (typeof request.timeoutMs !== 'number' || !Number.isFinite(request.timeoutMs)) {
      throw new Error('Rejected invalid shell request')
    }
    body.timeoutMs = request.timeoutMs
  }
  return body
}

/** Subscribe to `shell:event` before `spawnShell` so a `started` event cannot win the race. */
export function onShellEvent(listener: (payload: unknown) => void): ElectronDisposer {
  return bridge().on('shell:event', listener)
}

export async function spawnShell(request: ShellSpawnRequest): Promise<string> {
  const id = await bridge().invoke('shell:spawn', requestBody(request))
  if (typeof id !== 'string' || id.length === 0) throw new Error('Rejected invalid shell id')
  return id
}

export async function cancelShell(id: string): Promise<void> {
  if (typeof id !== 'string' || id.length === 0) throw new Error('Rejected invalid shell request')
  await bridge().invoke('shell:cancel', { id })
}
