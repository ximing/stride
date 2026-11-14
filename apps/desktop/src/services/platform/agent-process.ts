import { has, resolve } from '@rabjs/react'
import {
  agentExecutableCommand,
  isExternalAgentMode,
  unavailableAgentProcessHost,
  type AgentProcessExit,
  type AgentProcessHost,
  type AgentProcessSpawn,
  type AgentProcessTransport,
} from '@stride/platform'
import { SettingsService } from '../settings/settings.service'
import { isDesktopRuntime } from './runtime'

let override: AgentProcessHost | null = null
let desktop: AgentProcessHost | null = null

/** Tests install a fake stdio host here. Production leaves this null. */
export function setAgentProcessHostForTests(host: AgentProcessHost | null) {
  override = host
}

export function resolveAgentProcessHost(): AgentProcessHost {
  if (override) return override
  if (!isDesktopRuntime()) return unavailableAgentProcessHost()
  if (!desktop) desktop = createDesktopAgentProcessHost()
  return desktop
}

export function configuredAgentCommand(mode: 'grok' | 'claude' | 'codex'): string {
  if (!has(SettingsService)) return mode
  return agentExecutableCommand(mode, resolve(SettingsService).form.agent?.executables?.[mode])
}

function commandFor(spec: AgentProcessSpawn): string {
  if (!isExternalAgentMode(spec.command)) return spec.command
  return configuredAgentCommand(spec.command)
}

/** Renderer wrapper for `agent:probe`. Returns null in the browser so callers do not invoke IPC. */
export async function probeConfiguredAgent(
  mode: 'grok' | 'claude' | 'codex',
  command: string,
): Promise<{ found: boolean; resolved: string } | null> {
  if (!isDesktopRuntime()) return null
  const api = await import('@stride/electron-api')
  return api.probeAgent({ command, mode })
}

function createDesktopAgentProcessHost(): AgentProcessHost {
  return {
    available: true,
    spawn(spec) {
      return openDesktopAgent({ ...spec, command: commandFor(spec) })
    },
  }
}

async function openDesktopAgent(spec: AgentProcessSpawn): Promise<AgentProcessTransport> {
  const api = await import('@stride/electron-api')
  const buffered: Array<{ id?: string; event?: string; data?: string; code?: number | null; message?: string }> = []
  let id = ''
  let disposed = false
  const dataListeners = new Set<(chunk: string) => void>()
  const exitListeners = new Set<(info: AgentProcessExit) => void>()
  let exitInfo: AgentProcessExit | null = null
  // Claude writes system/init before spawnAgent resolves, and the client
  // subscribes only after spawn returns. Hold stdout until the first onData.
  let stdoutBuffer = ''

  const dispatch = (event: { event?: string; data?: string; code?: number | null; message?: string }) => {
    if (event.event === 'stdout' && typeof event.data === 'string') {
      if (dataListeners.size === 0) {
        stdoutBuffer += event.data
        return
      }
      for (const listener of dataListeners) listener(event.data)
      return
    }
    if (event.event === 'exit' && !exitInfo) {
      exitInfo = { code: typeof event.code === 'number' ? event.code : null, error: event.message }
      for (const listener of exitListeners) listener(exitInfo)
    }
  }

  const handle = (payload: unknown) => {
    if (!payload || typeof payload !== 'object') return
    const event = payload as { id?: string; event?: string; data?: string; code?: number | null; message?: string }
    if (!id) {
      buffered.push(event)
      return
    }
    if (event.id !== id) return
    dispatch(event)
  }

  const dispose = api.onAgentEvent(handle)
  try {
    id = await api.spawnAgent({ command: spec.command, args: [...spec.args], cwd: spec.cwd })
  } catch (error) {
    dispose()
    throw error
  }
  for (const event of buffered) {
    if (event.id === id) dispatch(event)
  }
  buffered.length = 0

  return {
    write(data: string) {
      return api.writeAgent(id, data)
    },
    onData(listener) {
      dataListeners.add(listener)
      if (stdoutBuffer) {
        const pending = stdoutBuffer
        stdoutBuffer = ''
        listener(pending)
      }
      return () => dataListeners.delete(listener)
    },
    onExit(listener) {
      exitListeners.add(listener)
      if (exitInfo) listener(exitInfo)
      return () => exitListeners.delete(listener)
    },
    async kill() {
      if (disposed) return
      disposed = true
      dispose()
      await api.killAgent(id).catch(() => undefined)
    },
  }
}
