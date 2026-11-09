import { Channel, invoke } from '@tauri-apps/api/core'
import {
  allowAllShellReviewer,
  ShellAbortError,
  ShellDeniedError,
  ShellTimeoutError,
  type ShellBackend,
  type ShellExecOptions,
  type ShellOutput,
  type ShellReview,
  type ShellReviewer,
  type ShellReviewRequest,
} from '@stride/platform'

const TRUNCATION_NOTICE = '[output truncated]'

function emptyOutput(): ShellOutput {
  return { stdout: '', stderr: '', code: null }
}

function abortError(): ShellAbortError {
  return new ShellAbortError(emptyOutput())
}

function sanitizeReason(reason: string): string {
  return reason.replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, 200)
}

/** Newline rule for the cap suffix only. Raw stdout and stderr chunks are concatenated as-is. */
function appendChunk(current: string, chunk: string): string {
  if (!chunk) return current
  if (!current) return chunk
  if (current.endsWith('\n') || chunk.startsWith('\n')) return current + chunk
  return `${current}\n${chunk}`
}

function reviewRequest(options: ShellExecOptions): ShellReviewRequest {
  const request: ShellReviewRequest = { command: options.command, cwd: options.cwd }
  if (options.timeoutSeconds !== undefined) request.timeoutSeconds = options.timeoutSeconds
  return request
}

function startReview(reviewer: ShellReviewer, request: ShellReviewRequest, signal?: AbortSignal): Promise<ShellReview> {
  try {
    return Promise.resolve(reviewer.review(request, signal))
  } catch (error) {
    return Promise.reject(error)
  }
}

function raceReview(review: Promise<ShellReview>, signal?: AbortSignal): Promise<ShellReview> {
  void review.catch(() => {})
  if (!signal) return review
  let stop = () => {}
  const aborted = new Promise<never>((_, reject) => {
    if (signal.aborted) {
      reject(abortError())
      return
    }
    const onAbort = () => reject(abortError())
    signal.addEventListener('abort', onAbort)
    stop = () => signal.removeEventListener('abort', onAbort)
  })
  return Promise.race([review, aborted]).finally(stop)
}

interface ExitEvent {
  code: number | null
  truncated: boolean
  reason: string
}

function readCode(value: unknown): number | null {
  return typeof value === 'number' ? value : null
}

function mapExit(event: ExitEvent, stdout: string, stderr: string, timeoutSeconds: number | undefined): ShellOutput | Error {
  const base = { stdout, stderr, code: event.code, truncated: event.truncated }
  if (event.reason === 'timeout') return new ShellTimeoutError(timeoutSeconds ?? 0, base)
  if (event.reason === 'cancel') return new ShellAbortError(base)
  if (event.reason === 'cap') {
    return {
      stdout,
      stderr: stderr.includes(TRUNCATION_NOTICE) ? stderr : appendChunk(stderr, TRUNCATION_NOTICE),
      code: event.code,
      truncated: true,
    }
  }
  if (event.reason === 'exit') return { stdout, stderr, code: event.code, truncated: event.truncated }
  return new Error(`Unknown shell exit: ${event.reason}`)
}

interface SpawnHooks {
  rememberId: (id: string) => void
  stopAbort: () => void
}

function spawn(options: ShellExecOptions, signal: AbortSignal | undefined, hooks: SpawnHooks): Promise<ShellOutput> {
  if (signal?.aborted) {
    hooks.stopAbort()
    return Promise.reject(abortError())
  }

  let stdout = ''
  let stderr = ''
  let settled = false
  const onEvent = new Channel<unknown>()
  const output = new Promise<ShellOutput>((resolve, reject) => {
    const finish = (settle: () => void) => {
      if (settled) return
      settled = true
      onEvent.onmessage = () => {}
      hooks.stopAbort()
      settle()
    }

    onEvent.onmessage = (message: unknown) => {
      if (settled || !message || typeof message !== 'object') return
      const record = message as Record<string, unknown>
      if (record.event === 'started') {
        if (typeof record.id === 'string') hooks.rememberId(record.id)
        return
      }
      if (record.event === 'stdout') {
        if (typeof record.data === 'string') stdout += record.data
        return
      }
      if (record.event === 'stderr') {
        if (typeof record.data === 'string') stderr += record.data
        return
      }
      if (record.event === 'error') {
        const text = typeof record.message === 'string' ? record.message : ''
        finish(() => reject(new Error(text)))
        return
      }
      if (record.event !== 'exit') return
      const result = mapExit(
        {
          code: readCode(record.code),
          truncated: record.truncated === true,
          reason: typeof record.reason === 'string' ? record.reason : '',
        },
        stdout,
        stderr,
        options.timeoutSeconds,
      )
      finish(() => {
        if (result instanceof Error) reject(result)
        else resolve(result)
      })
    }
  })

  const payload: {
    command: string
    cwd: string
    timeoutMs?: number
    onEvent: Channel<unknown>
  } = {
    command: options.command,
    cwd: options.cwd,
    onEvent,
  }
  if (options.timeoutSeconds !== undefined) payload.timeoutMs = options.timeoutSeconds * 1000

  return invoke<string>('shell_exec_spawn', payload).then(
    (returned) => {
      if (typeof returned === 'string') hooks.rememberId(returned)
      return output
    },
    (error: unknown) => {
      if (settled) return output
      settled = true
      onEvent.onmessage = () => {}
      hooks.stopAbort()
      throw error instanceof Error ? error : new Error(String(error))
    },
  )
}

async function execShell(options: ShellExecOptions, reviewer: ShellReviewer): Promise<ShellOutput> {
  if (!options.command.trim()) throw new Error('Command is empty')
  if (!options.cwd.trim()) throw new Error('Working directory is empty')

  const signal = options.signal
  if (signal?.aborted) throw abortError()

  let id: string | null = null
  let cancelSent = false
  const cancelOnce = () => {
    if (id === null || cancelSent) return
    cancelSent = true
    void invoke('shell_exec_cancel', { id }).catch(() => {})
  }
  const onAbort = () => {
    cancelOnce()
  }
  signal?.addEventListener('abort', onAbort)
  const stopAbort = () => {
    signal?.removeEventListener('abort', onAbort)
  }
  const rememberId = (next: string) => {
    if (!next) return
    if (id === null) id = next
    if (signal?.aborted) cancelOnce()
  }

  try {
    const decision = await raceReview(startReview(reviewer, reviewRequest(options), signal), signal)
    if (signal?.aborted) throw abortError()
    if (decision.action === 'deny') throw new ShellDeniedError(sanitizeReason(decision.reason))
    if (signal?.aborted) throw abortError()
    return await spawn(options, signal, { rememberId, stopAbort })
  } catch (error) {
    stopAbort()
    throw error
  }
}

export function shellBackend(options?: { reviewer?: ShellReviewer }): ShellBackend {
  const reviewer = options?.reviewer ?? allowAllShellReviewer()
  return {
    available: true,
    exec(execOptions) {
      return execShell(execOptions, reviewer)
    },
  }
}
