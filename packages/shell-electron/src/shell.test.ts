import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ShellAbortError, ShellDeniedError, ShellTimeoutError } from '@stride/platform'
import { shellBackend } from './index.ts'

interface SpawnPayload {
  command?: string
  cwd?: string
  timeoutMs?: number
  [key: string]: unknown
}

const spawnShell = vi.hoisted(() => vi.fn())
const cancelShell = vi.hoisted(() => vi.fn())
const listeners = vi.hoisted(() => new Set<(payload: unknown) => void>())
const onShellEvent = vi.hoisted(() =>
  vi.fn((listener: (payload: unknown) => void) => {
    listeners.add(listener)
    let removed = false
    return () => {
      if (removed) return
      removed = true
      listeners.delete(listener)
    }
  }),
)

vi.mock('@stride/electron-api', () => ({
  spawnShell,
  cancelShell,
  onShellEvent,
}))

function emit(message: unknown) {
  for (const listener of [...listeners]) listener(message)
}

function exit(reason: string, code: number | null = 0, truncated = false) {
  return { id: 'id-1', event: 'exit', code, truncated, reason }
}

beforeEach(() => {
  spawnShell.mockReset()
  cancelShell.mockReset()
  onShellEvent.mockClear()
  listeners.clear()
  cancelShell.mockResolvedValue(undefined)
})

describe('electron shell', () => {
  it('deny before spawn leaves spawn count at 0 and does not subscribe', async () => {
    const backend = shellBackend({
      reviewer: {
        review: () => Promise.resolve({ action: 'deny', reason: 'unsafe' }),
      },
    })
    const pending = backend.exec({ command: 'echo hi', cwd: '/vault' })
    await expect(pending).rejects.toBeInstanceOf(ShellDeniedError)
    await expect(pending).rejects.toMatchObject({ reason: 'unsafe' })
    expect(spawnShell).toHaveBeenCalledTimes(0)
    expect(onShellEvent).toHaveBeenCalledTimes(0)
    expect(listeners.size).toBe(0)
  })

  it('abort during review leaves spawn count at 0 and does not subscribe', async () => {
    let allow: ((decision: { action: 'allow' }) => void) | undefined
    const review = new Promise<{ action: 'allow' }>((resolve) => {
      allow = resolve
    })
    const backend = shellBackend({
      reviewer: {
        review: () => review,
      },
    })
    const controller = new AbortController()
    const pending = backend.exec({ command: 'echo hi', cwd: '/vault', signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toBeInstanceOf(ShellAbortError)
    await expect(pending).rejects.toMatchObject({ output: { stdout: '', stderr: '', code: null } })
    expect(spawnShell).toHaveBeenCalledTimes(0)
    expect(onShellEvent).toHaveBeenCalledTimes(0)
    allow?.({ action: 'allow' })
    await Promise.resolve()
    await Promise.resolve()
    expect(spawnShell).toHaveBeenCalledTimes(0)
    expect(listeners.size).toBe(0)
  })

  it('subscribes before spawn and passes only command, cwd, and timeoutMs', async () => {
    let payload: SpawnPayload | undefined
    let listenersAtSpawn = 0
    spawnShell.mockImplementation((args: SpawnPayload) => {
      listenersAtSpawn = listeners.size
      payload = args
      emit(exit('exit', 0, false))
      return Promise.resolve('id-1')
    })
    const requests: unknown[] = []
    const backend = shellBackend({
      reviewer: {
        review(request) {
          requests.push(request)
          return Promise.resolve({ action: 'allow' })
        },
      },
    })
    await backend.exec({ command: 'echo hi', cwd: '/vault', timeoutSeconds: 0.0204 })
    expect(listenersAtSpawn).toBe(1)
    expect(onShellEvent).toHaveBeenCalledTimes(1)
    expect(listeners.size).toBe(0)
    expect(payload).toBeDefined()
    expect(Object.keys(payload ?? {}).sort()).toEqual(['command', 'cwd', 'timeoutMs'])
    expect(payload).toMatchObject({ command: 'echo hi', cwd: '/vault' })
    expect(payload?.timeoutMs).toBe(0.0204 * 1000)
    expect(payload?.timeoutMs).not.toBe(20)
    expect(payload?.timeoutMs).not.toBe(21)
    expect(payload?.timeoutMs).not.toBe(Math.round(0.0204 * 1000))
    expect(payload).not.toHaveProperty('program')
    expect(payload).not.toHaveProperty('args')
    expect(payload).not.toHaveProperty('env')
    expect(payload).not.toHaveProperty('onEvent')
    expect(requests).toEqual([{ command: 'echo hi', cwd: '/vault', timeoutSeconds: 0.0204 }])
  })

  it('cap resolves with null code and truncated true', async () => {
    spawnShell.mockImplementation(() => {
      emit({ id: 'id-1', event: 'stderr', data: 'partial' })
      emit(exit('cap', null, true))
      return Promise.resolve('id-1')
    })
    const output = await shellBackend().exec({ command: 'echo hi', cwd: '/vault' })
    expect(output.code).toBeNull()
    expect(output.truncated).toBe(true)
    expect(output.stderr).toBe('partial\n[output truncated]')
    expect(output.stderr).toContain('[output truncated]')
    expect(listeners.size).toBe(0)
  })

  it('abort after id cancels exactly once', async () => {
    const controller = new AbortController()
    const cancels: unknown[] = []
    let resolveSpawn: ((id: string) => void) | undefined
    const spawned = new Promise<string>((resolve) => {
      resolveSpawn = resolve
    })
    spawnShell.mockImplementation(() => spawned)
    cancelShell.mockImplementation((id: string) => {
      cancels.push(id)
      return Promise.resolve()
    })
    const pending = shellBackend().exec({
      command: 'sleep 30',
      cwd: '/vault',
      signal: controller.signal,
    })
    await vi.waitFor(() => {
      expect(listeners.size).toBe(1)
    })
    emit({ id: 'job-1', event: 'started' })
    emit({ id: 'job-1', event: 'stdout', data: 'so-far' })
    resolveSpawn?.('job-1')
    await Promise.resolve()
    await Promise.resolve()
    controller.abort()
    expect(cancels).toEqual(['job-1'])
    let settled = false
    void pending.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      },
    )
    await Promise.resolve()
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(cancelShell).toHaveBeenCalledTimes(1)
    emit({ id: 'job-1', event: 'exit', code: null, truncated: false, reason: 'cancel' })
    await expect(pending).rejects.toBeInstanceOf(ShellAbortError)
    await expect(pending).rejects.toMatchObject({ output: { stdout: 'so-far', code: null } })
    expect(cancels).toEqual(['job-1'])
    expect(listeners.size).toBe(0)
    controller.abort()
    expect(cancelShell).toHaveBeenCalledTimes(1)
  })

  it('concatenates raw stdout chunks without inserting newlines', async () => {
    spawnShell.mockImplementation(() => {
      emit({ id: 'id-1', event: 'stdout', data: 'foo' })
      emit({ id: 'id-1', event: 'stdout', data: 'bar' })
      emit({ id: 'id-1', event: 'stderr', data: 'a' })
      emit({ id: 'id-1', event: 'stderr', data: 'b' })
      emit(exit('exit', 0, false))
      return Promise.resolve('id-1')
    })
    const output = await shellBackend().exec({ command: 'printf hi', cwd: '/vault' })
    expect(output.stdout).toBe('foobar')
    expect(output.stderr).toBe('ab')
    expect(output.code).toBe(0)
    expect(listeners.size).toBe(0)
  })

  it('maps a timeout exit to the caller timeoutSeconds', async () => {
    spawnShell.mockImplementation(() => {
      emit({ id: 'id-1', event: 'stdout', data: 'partial' })
      emit({ id: 'id-1', event: 'stderr', data: 'err' })
      emit(exit('timeout', null, false))
      return Promise.resolve('id-1')
    })
    const pending = shellBackend().exec({ command: 'sleep 30', cwd: '/vault', timeoutSeconds: 0.0204 })
    await expect(pending).rejects.toBeInstanceOf(ShellTimeoutError)
    await expect(pending).rejects.toMatchObject({
      seconds: 0.0204,
      output: { stdout: 'partial', stderr: 'err' },
    })
    expect(listeners.size).toBe(0)
  })

  it('keeps the original timeoutSeconds when dividing the milliseconds would drift', async () => {
    spawnShell.mockImplementation(() => {
      emit(exit('timeout', null, false))
      return Promise.resolve('id-1')
    })
    const timeoutSeconds = 0.0021
    const pending = shellBackend().exec({ command: 'sleep 1', cwd: '/vault', timeoutSeconds })
    await expect(pending).rejects.toMatchObject({ seconds: timeoutSeconds })
    expect((timeoutSeconds * 1000) / 1000).not.toBe(timeoutSeconds)
  })

  it('does not spawn an empty command', async () => {
    await expect(shellBackend().exec({ command: ' \n\t', cwd: '/vault' })).rejects.toThrow('Command is empty')
    await expect(shellBackend().exec({ command: 'echo', cwd: '  ' })).rejects.toThrow('Working directory is empty')
    expect(spawnShell).not.toHaveBeenCalled()
    expect(onShellEvent).not.toHaveBeenCalled()
  })

  it('does not probe PATH from JavaScript', async () => {
    spawnShell.mockImplementation(() => {
      emit(exit('exit', 0, false))
      return Promise.resolve('id-1')
    })
    await shellBackend().exec({ command: 'echo hi', cwd: '/vault' })
    expect(spawnShell).toHaveBeenCalledTimes(1)
    for (const call of spawnShell.mock.calls) {
      const blob = JSON.stringify(call)
      expect(blob).not.toContain('-lic')
      expect(blob).not.toContain('__STRIDE_PATH__')
    }
  })

  it('cancels once when the caller aborted before the id arrived', async () => {
    const controller = new AbortController()
    const cancels: unknown[] = []
    let resolveSpawn: ((id: string) => void) | undefined
    const spawned = new Promise<string>((resolve) => {
      resolveSpawn = resolve
    })
    spawnShell.mockImplementation(() => spawned)
    cancelShell.mockImplementation((id: string) => {
      cancels.push(id)
      return Promise.resolve()
    })
    const pending = shellBackend().exec({ command: 'sleep 30', cwd: '/vault', signal: controller.signal })
    await vi.waitFor(() => {
      expect(listeners.size).toBe(1)
    })
    controller.abort()
    expect(cancels).toEqual([])
    emit({ id: 'early', event: 'started' })
    expect(cancels).toEqual(['early'])
    resolveSpawn?.('early')
    await Promise.resolve()
    await Promise.resolve()
    expect(cancels).toEqual(['early'])
    emit({ id: 'early', event: 'stdout', data: 'partial' })
    emit({ id: 'early', event: 'exit', code: null, truncated: false, reason: 'cancel' })
    await expect(pending).rejects.toMatchObject({ output: { stdout: 'partial' } })
    expect(listeners.size).toBe(0)
    expect(cancelShell).toHaveBeenCalledTimes(1)
  })

  it('ignores unknown frames until an exit event and drops the listener', async () => {
    let release: ((id: string) => void) | undefined
    spawnShell.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          release = resolve
        }),
    )
    const pending = shellBackend().exec({ command: 'echo hi', cwd: '/vault' })
    await vi.waitFor(() => {
      expect(listeners.size).toBe(1)
    })
    emit({ end: true })
    let settled = false
    void pending.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      },
    )
    await Promise.resolve()
    await Promise.resolve()
    expect(settled).toBe(false)
    emit({ id: 'id-1', event: 'stdout', data: 'ok' })
    emit(exit('exit', 3, false))
    release?.('id-1')
    await expect(pending).resolves.toMatchObject({ stdout: 'ok', code: 3, truncated: false })
    expect(listeners.size).toBe(0)
    emit({ id: 'id-1', event: 'stdout', data: 'late' })
    await expect(pending).resolves.toMatchObject({ stdout: 'ok' })
  })

  it('strips control characters, trims, and cuts a deny reason to 200 characters', async () => {
    const backend = shellBackend({
      reviewer: {
        review: () => Promise.resolve({ action: 'deny', reason: `\u0001  ${'x'.repeat(250)}\n\u007F` }),
      },
    })
    await expect(backend.exec({ command: 'echo hi', cwd: '/vault' })).rejects.toMatchObject({
      reason: 'x'.repeat(200),
    })
    const empty = shellBackend({
      reviewer: {
        review: () => Promise.resolve({ action: 'deny', reason: '\u0000\n' }),
      },
    })
    await expect(empty.exec({ command: 'echo hi', cwd: '/vault' })).rejects.toMatchObject({ reason: '' })
    expect(spawnShell).not.toHaveBeenCalled()
    expect(onShellEvent).not.toHaveBeenCalled()
  })

  it('rejects with the error event message and rethrows spawn failures', async () => {
    spawnShell.mockImplementation(() => {
      emit({ id: 'id-1', event: 'error', message: 'No shell is available' })
      return Promise.resolve('id-1')
    })
    await expect(shellBackend().exec({ command: 'echo hi', cwd: '/vault' })).rejects.toThrow('No shell is available')
    expect(listeners.size).toBe(0)
    spawnShell.mockRejectedValue(new Error('spawn failed'))
    await expect(shellBackend().exec({ command: 'echo hi', cwd: '/vault' })).rejects.toThrow('spawn failed')
    expect(listeners.size).toBe(0)
    spawnShell.mockRejectedValue('boom')
    await expect(shellBackend().exec({ command: 'echo hi', cwd: '/vault' })).rejects.toThrow('boom')
    expect(listeners.size).toBe(0)
    expect(onShellEvent).toHaveBeenCalledTimes(3)
  })

  it('keeps output that arrived before the session id and ignores other sessions', async () => {
    spawnShell.mockImplementation(() => {
      emit({ id: 'other', event: 'stdout', data: 'nope' })
      emit({ id: 'id-1', event: 'stdout', data: 'yes' })
      emit({ id: 'id-1', event: 'started' })
      emit({ id: 'other', event: 'exit', code: 9, truncated: false, reason: 'exit' })
      emit(exit('exit', 0, false))
      return Promise.resolve('id-1')
    })
    const output = await shellBackend().exec({ command: 'echo hi', cwd: '/vault' })
    expect(output).toMatchObject({ stdout: 'yes', code: 0 })
    expect(listeners.size).toBe(0)
  })
})
