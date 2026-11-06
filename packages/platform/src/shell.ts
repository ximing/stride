import { PlatformError } from './error.ts'

/** Result of one shell command. `code` is null when the process was killed by a signal. */
export interface ShellOutput {
  stdout: string
  stderr: string
  code: number | null
  /** The runner stopped reading because the output passed its collection cap. */
  truncated?: boolean
}

export interface ShellExecOptions {
  command: string
  /** Absolute working directory. The vault root for the assistant. */
  cwd: string
  /** Seconds. Omit for no timeout. */
  timeoutSeconds?: number
  signal?: AbortSignal
}

export interface ShellBackend {
  readonly available: boolean
  exec(options: ShellExecOptions): Promise<ShellOutput>
}

export class ShellAbortError extends Error {
  readonly output: ShellOutput

  constructor(output: ShellOutput) {
    super('aborted')
    this.name = 'ShellAbortError'
    this.output = output
  }
}

export class ShellTimeoutError extends Error {
  readonly seconds: number
  readonly output: ShellOutput

  constructor(seconds: number, output: ShellOutput) {
    super(`timeout:${seconds}`)
    this.name = 'ShellTimeoutError'
    this.seconds = seconds
    this.output = output
  }
}

export function unavailableShell(): ShellBackend {
  return {
    available: false,
    exec() {
      return Promise.reject(new PlatformError('shell-unavailable', 'Shell is not available'))
    },
  }
}

/** Records commands and returns a scripted result. Used by tool tests. */
export class MemoryShell implements ShellBackend {
  readonly available = true
  readonly calls: ShellExecOptions[] = []
  next: ShellOutput | Error = { stdout: '', stderr: '', code: 0 }

  exec(options: ShellExecOptions): Promise<ShellOutput> {
    if (options.signal?.aborted) return Promise.reject(new ShellAbortError({ stdout: '', stderr: '', code: null }))
    this.calls.push(options)
    if (this.next instanceof Error) return Promise.reject(this.next)
    return Promise.resolve(this.next)
  }
}
