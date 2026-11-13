import { cancelShell, onShellEvent, spawnShell, type ShellSpawnRequest } from '@stride/electron-api'
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

function eventId(record: Record<string, unknown>): string {
  return typeof record.id === 'string' ? record.id : ''
}

function spawn(options: ShellExecOptions, signal: AbortSignal | undefined, hooks: SpawnHooks): Promise<ShellOutput> {
  if (signal?.aborted) {
    hooks.stopAbort()
    return Promise.reject(abortError())
  }

  let stdout = ''
  let stderr = ''
  let settled = false
  let sessionId: string | null = null
  const buffered: Record<string, unknown>[] = []
  let dispose = () => {}
  const unsubscribe = () => {
    const current = dispose
    dispose = () => {}
    current()
  }

  let adopt = (_next: string) => {}

  const output = new Promise<ShellOutput>((resolve, reject) => {
    const finish = (settle: () => void) => {
      if (settled) return
      settled = true
      unsubscribe()
      hooks.stopAbort()
      settle()
    }

    const apply = (record: Record<string, unknown>) => {
      if (settled) return
      if (sessionId !== null && eventId(record) !== sessionId) return
      if (record.event === 'started') {
        if (eventId(record)) adopt(eventId(record))
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

    adopt = (next: string) => {
      if (!next || settled) return
      if (sessionId === null) sessionId = next
      hooks.rememberId(sessionId)
      if (sessionId !== next) return
      const pending = buffered.splice(0, buffered.length)
      for (const record of pending) {
        if (eventId(record) !== sessionId) continue
        apply(record)
        if (settled) return
      }
    }

    const onEvent = (message: unknown) => {
      if (settled || !message || typeof message !== 'object') return
      const record = message as Record<string, unknown>
      if (sessionId === null) {
        if (record.event === 'started' && eventId(record)) {
          adopt(eventId(record))
          return
        }
        buffered.push(record)
        return
      }
      if (eventId(record) !== sessionId) return
      apply(record)
    }

    // Subscribe before spawn so a started event cannot arrive first unobserved.
    dispose = onShellEvent(onEvent)
  })

  const payload: ShellSpawnRequest = {
    command: options.command,
    cwd: options.cwd,
  }
  if (options.timeoutSeconds !== undefined) payload.timeoutMs = options.timeoutSeconds * 1000

  return spawnShell(payload).then(
    (returned) => {
      if (typeof returned === 'string') adopt(returned)
      return output
    },
    (error: unknown) => {
      if (settled) return output
      settled = true
      unsubscribe()
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
    void cancelShell(id).catch(() => {})
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
