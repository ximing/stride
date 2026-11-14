import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentProcessExit, AgentProcessHost, AgentProcessSpawn, AgentProcessTransport } from '@stride/platform'

function peerFile(): string {
  const candidates = [
    join(process.cwd(), 'src/services/chat/external-agent-peer.mjs'),
    join(process.cwd(), 'apps/desktop/src/services/chat/external-agent-peer.mjs'),
  ]
  const found = candidates.find((candidate) => existsSync(candidate))
  if (!found) throw new Error(`external agent peer is missing (looked in ${candidates.join(', ')})`)
  return found
}

/**
 * Spawns the fake stdio peer with the argv the chat service requested.
 * The child process stays in this closure. A reactive proxy around the
 * transport must not wrap the socket: native stdin.write then throws.
 * Stdout and exit are buffered until the shipped client subscribes, because
 * Claude writes its init frame as soon as the process starts.
 */
export interface PeerHost extends AgentProcessHost {
  spawns: AgentProcessSpawn[]
  writes: string[]
  readonly killCalls: number
  killAll(): Promise<void>
}

function openPeer(child: ChildProcess, writes: string[], stats: { killCalls: number }): AgentProcessTransport {
  const dataListeners = new Set<(chunk: string) => void>()
  const exitListeners = new Set<(info: AgentProcessExit) => void>()
  let buffer = ''
  let exitInfo: AgentProcessExit | null = null
  let killed = false

  child.stdout?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => {
    if (dataListeners.size === 0) {
      buffer += chunk
      return
    }
    for (const listener of dataListeners) listener(chunk)
  })
  child.stderr?.resume()
  const finish = (info: AgentProcessExit) => {
    if (exitInfo) return
    exitInfo = info
    for (const listener of exitListeners) listener(info)
  }
  child.on('error', (error) => finish({ code: null, error: error.message }))
  child.on('exit', (code) => {
    finish({ code, error: code && code !== 0 ? `exit ${code}` : undefined })
  })

  return {
    write(data: string) {
      writes.push(data)
      const stdin = child.stdin
      if (!stdin || stdin.destroyed) return Promise.reject(new Error('stdin closed'))
      return new Promise((resolve, reject) => {
        stdin.write(data, (error) => (error ? reject(error) : resolve()))
      })
    },
    onData(listener) {
      dataListeners.add(listener)
      if (buffer) {
        const buffered = buffer
        buffer = ''
        listener(buffered)
      }
      return () => {
        dataListeners.delete(listener)
      }
    },
    onExit(listener) {
      exitListeners.add(listener)
      if (exitInfo) listener(exitInfo)
      return () => {
        exitListeners.delete(listener)
      }
    },
    async kill() {
      stats.killCalls += 1
      if (killed) return
      killed = true
      const pid = child.pid
      if (!pid) return
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // Already gone.
      }
    },
  }
}

function peerResumeEnv(resume: 'fail' | 'exit' | undefined, spec: AgentProcessSpawn): string {
  if (resume === 'fail') return 'fail'
  if (resume !== 'exit') return ''
  if (spec.command === 'claude') return spec.args.includes('--resume') ? 'exit' : ''
  if (spec.command === 'codex') return 'exit'
  return ''
}

export function createPeerHost(options?: {
  missing?: boolean
  failHandshake?: boolean
  cancel?: 'exit' | 'missing'
  resume?: 'fail' | 'exit'
}): PeerHost {
  const spawns: AgentProcessSpawn[] = []
  const writes: string[] = []
  const transports: AgentProcessTransport[] = []
  const stats = { killCalls: 0 }
  return {
    available: true,
    spawns,
    writes,
    get killCalls() {
      return stats.killCalls
    },
    async spawn(spec) {
      const requested: AgentProcessSpawn = { command: spec.command, args: [...spec.args], cwd: spec.cwd }
      spawns.push(requested)
      if (options?.missing) {
        const error = new Error(`spawn ${spec.command} ENOENT`) as NodeJS.ErrnoException
        error.code = 'ENOENT'
        throw error
      }
      const child = spawn(process.execPath, [peerFile(), spec.command], {
        cwd: process.cwd(),
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          PEER_MODE: options?.failHandshake ? 'fail-handshake' : '',
          PEER_CANCEL: options?.cancel ?? '',
          PEER_RESUME: peerResumeEnv(options?.resume, spec),
        },
      })
      const transport = openPeer(child, writes, stats)
      transports.push(transport)
      return transport
    },
    async killAll() {
      await Promise.all(transports.map((transport) => transport.kill()))
    },
  }
}
