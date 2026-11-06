import { Command } from '@tauri-apps/plugin-shell'
import {
  ShellAbortError,
  ShellTimeoutError,
  type ShellBackend,
  type ShellExecOptions,
  type ShellOutput,
} from '@stride/platform'

const SENTINEL = '__STRIDE_PATH__'
const PROBE_TIMEOUT_MS = 8_000
const MAX_COLLECT_BYTES = 1024 * 1024
const LOGIN_SHELLS = ['zsh', 'bash', 'sh'] as const
const COMMAND_SHELLS = ['bash', 'zsh', 'sh'] as const

interface RunOptions {
  cwd?: string
  env?: Record<string, string>
  timeoutMs?: number
  signal?: AbortSignal
}

let pathCache: Promise<string | undefined> | null = null
let commandShell: string | null = null

export function resetShellSessionForTests() {
  pathCache = null
  commandShell = null
}

function emptyOutput(): ShellOutput {
  return { stdout: '', stderr: '', code: null }
}

function missingProgram(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error)
  return text.includes('program not allowed on the configured shell scope')
    || text.includes('No such file or directory')
    || text.includes('os error 2')
}

function appendChunk(current: string, chunk: string): string {
  if (!chunk) return current
  if (!current) return chunk
  if (current.endsWith('\n') || chunk.startsWith('\n')) return current + chunk
  return `${current}\n${chunk}`
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length
}

function readPath(output: ShellOutput): string | undefined {
  if (output.code !== 0) return undefined
  const text = `${output.stdout}\n${output.stderr}`
  const at = text.lastIndexOf(SENTINEL)
  if (at < 0) return undefined
  const path = text.slice(at + SENTINEL.length).trim().split(/\r?\n/)[0]?.trim()
  return path || undefined
}

/**
 * Spawn a configured shell program. stdout and stderr events are lines; a missing
 * trailing newline is preserved when the chunk already contains one.
 */
function run(program: string, args: string[], options: RunOptions = {}): Promise<ShellOutput> {
  if (options.signal?.aborted) return Promise.reject(new ShellAbortError(emptyOutput()))
  const command = Command.create(program, args, {
    cwd: options.cwd,
    env: options.env,
    processGroup: true,
  })
  let stdout = ''
  let stderr = ''
  let truncated = false
  let child: { kill(): Promise<void> } | null = null
  let settled = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let stop: 'abort' | 'timeout' | null = null

  return new Promise((resolve, reject) => {
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      fn()
    }
    const kill = () => {
      if (child) void child.kill()
    }
    const onAbort = () => {
      stop = 'abort'
      kill()
    }
    const cap = (next: string) => {
      if (truncated) return
      if (byteLength(next) <= MAX_COLLECT_BYTES) return
      truncated = true
      kill()
    }
    command.stdout.on('data', (chunk: string) => {
      if (truncated) return
      stdout = appendChunk(stdout, chunk)
      cap(stdout + stderr)
    })
    command.stderr.on('data', (chunk: string) => {
      if (truncated) return
      stderr = appendChunk(stderr, chunk)
      cap(stdout + stderr)
    })
    command.on('error', (error: string) => {
      finish(() => reject(new Error(error)))
    })
    command.on('close', (payload: { code: number | null }) => {
      const result: ShellOutput = {
        stdout,
        stderr: truncated ? appendChunk(stderr, '[output truncated]') : stderr,
        code: payload.code,
        truncated,
      }
      if (stop === 'abort') {
        finish(() => reject(new ShellAbortError(result)))
        return
      }
      if (stop === 'timeout') {
        finish(() => reject(new ShellTimeoutError((options.timeoutMs ?? 0) / 1000, result)))
        return
      }
      finish(() => resolve(result))
    })
    if (options.signal) options.signal.addEventListener('abort', onAbort)
    if (options.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        stop = 'timeout'
        kill()
      }, options.timeoutMs)
    }
    command.spawn().then((spawned) => {
      child = spawned
      if (settled) return
      if (stop || options.signal?.aborted) {
        if (options.signal?.aborted) stop = 'abort'
        void spawned.kill()
      }
    }).catch((error: unknown) => {
      finish(() => reject(error instanceof Error ? error : new Error(String(error))))
    })
  })
}

async function probeLoginPath(signal?: AbortSignal): Promise<string | undefined> {
  for (const program of LOGIN_SHELLS) {
    if (signal?.aborted) throw new ShellAbortError(emptyOutput())
    try {
      const output = await run(program, ['-lic', `printf '\\n${SENTINEL}%s' "$PATH"`], {
        timeoutMs: PROBE_TIMEOUT_MS,
        signal,
      })
      const path = readPath(output)
      if (path) return path
    } catch (error) {
      if (error instanceof ShellAbortError) throw error
    }
  }
  return undefined
}

function loginPath(signal?: AbortSignal): Promise<string | undefined> {
  if (signal?.aborted) return Promise.reject(new ShellAbortError(emptyOutput()))
  if (!pathCache) {
    pathCache = probeLoginPath(signal).catch((error: unknown) => {
      pathCache = null
      throw error
    })
  }
  return pathCache
}

async function runCommand(command: string, options: RunOptions): Promise<ShellOutput> {
  const programs = commandShell ? [commandShell] : [...COMMAND_SHELLS]
  let last: unknown
  for (const program of programs) {
    try {
      const output = await run(program, ['-c', command], options)
      commandShell = program
      return output
    } catch (error) {
      if (error instanceof ShellAbortError || error instanceof ShellTimeoutError || !missingProgram(error)) throw error
      commandShell = null
      last = error
    }
  }
  throw last instanceof Error ? last : new Error('No shell is available')
}

async function execShell(options: ShellExecOptions): Promise<ShellOutput> {
  const command = options.command
  if (!command.trim()) throw new Error('Command is empty')
  if (!options.cwd.trim()) throw new Error('Working directory is empty')
  const path = await loginPath(options.signal)
  const timeoutMs = options.timeoutSeconds === undefined ? undefined : options.timeoutSeconds * 1000
  return runCommand(command, {
    cwd: options.cwd,
    env: path ? { PATH: path } : undefined,
    timeoutMs,
    signal: options.signal,
  })
}

export function shellBackend(): ShellBackend {
  return {
    available: true,
    exec: execShell,
  }
}
