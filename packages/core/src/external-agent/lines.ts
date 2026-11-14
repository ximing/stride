import type { AgentProcessExit } from '@stride/platform'
import { ExternalAgentError, type ExternalAgentFailure } from './errors.ts'

export function createLineReader(onLine: (line: string) => void): (chunk: string) => void {
  let buffer = ''
  return (chunk: string) => {
    buffer += chunk
    let newline = buffer.indexOf('\n')
    while (newline >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, '')
      buffer = buffer.slice(newline + 1)
      if (line.trim()) onLine(line)
      newline = buffer.indexOf('\n')
    }
  }
}

export function remainingMs(deadline: number): number {
  return Math.max(0, deadline - Date.now())
}

/**
 * One reader over stdout lines. Exit and abort reject the waiter.
 * Buffered lines are delivered before a close.
 */
export class LineQueue {
  private readonly lines: string[] = []
  private waiters: Array<(line: string | null) => void> = []
  private exitInfo: AgentProcessExit | null = null

  push(line: string) {
    const waiter = this.waiters.shift()
    if (waiter) waiter(line)
    else this.lines.push(line)
  }

  close(info: AgentProcessExit) {
    if (this.exitInfo) return
    this.exitInfo = info
    for (const waiter of this.waiters.splice(0)) waiter(null)
  }

  next(signal: AbortSignal, timeoutMs: number, timeoutFailure: ExternalAgentFailure): Promise<string> {
    if (signal.aborted) return Promise.reject(new ExternalAgentError('abort', 'aborted'))
    if (this.lines.length > 0) return Promise.resolve(this.lines.shift()!)
    if (this.exitInfo) return Promise.reject(exitError(this.exitInfo))
    if (timeoutMs <= 0) return Promise.reject(new ExternalAgentError(timeoutFailure, 'timed out'))
    return new Promise((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        finish(() => reject(new ExternalAgentError(timeoutFailure, 'timed out')))
      }, timeoutMs)
      const onAbort = () => finish(() => reject(new ExternalAgentError('abort', 'aborted')))
      const deliver = (line: string | null) => {
        if (line === null) finish(() => reject(exitError(this.exitInfo ?? { code: null })))
        else finish(() => resolve(line))
      }
      const finish = (settle: () => void) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        const index = this.waiters.indexOf(deliver)
        if (index >= 0) this.waiters.splice(index, 1)
        settle()
      }
      signal.addEventListener('abort', onAbort)
      this.waiters.push(deliver)
    })
  }
}

function exitError(info: AgentProcessExit): ExternalAgentError {
  const detail = info.error ?? 'process exited'
  if (/ENOENT|not found/i.test(detail)) return new ExternalAgentError('missing', detail)
  return new ExternalAgentError('failed', detail)
}

export function parseJsonLine(line: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(line)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}
