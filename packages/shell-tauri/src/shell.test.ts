import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ShellAbortError, ShellDeniedError, ShellTimeoutError } from '@stride/platform'
import { shellBackend } from './index.ts'

interface EventChannel {
  onmessage: ((message: unknown) => void) | null
}

interface SpawnPayload {
  command?: string
  cwd?: string
  timeoutMs?: number
  onEvent: EventChannel
  [key: string]: unknown
}

const invoke = vi.hoisted(() => vi.fn())

vi.mock('@tauri-apps/api/core', () => ({
  invoke,
  Channel: class Channel {
    onmessage: ((message: unknown) => void) | null = null
  },
}))

function exit(reason: string, code: number | null = 0, truncated = false) {
  return { event: 'exit', code, truncated, reason }
}

beforeEach(() => {
  invoke.mockReset()
})

describe('desktop shell', () => {
  it('deny before invoke leaves invoke count at 0', async () => {
    const backend = shellBackend({
      reviewer: {
        review: () => Promise.resolve({ action: 'deny', reason: 'unsafe' }),
      },
    })
    const pending = backend.exec({ command: 'echo hi', cwd: '/vault' })
    await expect(pending).rejects.toBeInstanceOf(ShellDeniedError)
    await expect(pending).rejects.toMatchObject({ reason: 'unsafe' })
    expect(invoke).toHaveBeenCalledTimes(0)
  })

  it('abort during review leaves invoke count at 0', async () => {
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
    expect(invoke).toHaveBeenCalledTimes(0)
    allow?.({ action: 'allow' })
    await Promise.resolve()
    await Promise.resolve()
    expect(invoke).toHaveBeenCalledTimes(0)
  })

  it('allow passes only command, cwd, timeoutMs, and onEvent', async () => {
    let payload: SpawnPayload | undefined
    let onmessageAtInvoke: unknown
    invoke.mockImplementation((command: string, args: SpawnPayload) => {
      expect(command).toBe('shell_exec_spawn')
      onmessageAtInvoke = args.onEvent.onmessage
      payload = args
      args.onEvent.onmessage?.(exit('exit', 0, false))
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
    expect(typeof onmessageAtInvoke).toBe('function')
    expect(payload).toBeDefined()
    expect(Object.keys(payload ?? {}).sort()).toEqual(['command', 'cwd', 'onEvent', 'timeoutMs'])
    expect(payload).toMatchObject({ command: 'echo hi', cwd: '/vault' })
    expect(payload?.timeoutMs).toBe(0.0204 * 1000)
    expect(payload?.timeoutMs).not.toBe(20)
    expect(payload?.timeoutMs).not.toBe(21)
    expect(payload?.timeoutMs).not.toBe(Math.round(0.0204 * 1000))
    expect(payload).not.toHaveProperty('program')
    expect(payload).not.toHaveProperty('args')
    expect(payload).not.toHaveProperty('env')
    expect(payload).not.toHaveProperty('webview')
    expect(payload).not.toHaveProperty('request')
    expect(requests).toEqual([{ command: 'echo hi', cwd: '/vault', timeoutSeconds: 0.0204 }])
  })

  it('cap resolves with null code and truncated true', async () => {
    invoke.mockImplementation((_command: string, args: SpawnPayload) => {
      args.onEvent.onmessage?.({ event: 'stderr', data: 'partial' })
      args.onEvent.onmessage?.(exit('cap', null, true))
      return Promise.resolve('id-1')
    })
    const output = await shellBackend().exec({ command: 'echo hi', cwd: '/vault' })
    expect(output.code).toBeNull()
    expect(output.truncated).toBe(true)
    expect(output.stderr).toBe('partial\n[output truncated]')
    expect(output.stderr).toContain('[output truncated]')
  })

  it('abort after id cancels exactly once', async () => {
    const controller = new AbortController()
    let payload: SpawnPayload | undefined
    const cancels: unknown[] = []
    let resolveSpawn: ((id: string) => void) | undefined
    const spawned = new Promise<string>((resolve) => {
      resolveSpawn = resolve
    })
    invoke.mockImplementation((command: string, args: unknown) => {
      if (command === 'shell_exec_cancel') {
        cancels.push(args)
        return Promise.resolve()
      }
      payload = args as SpawnPayload
      return spawned
    })
    const pending = shellBackend().exec({
      command: 'sleep 30',
      cwd: '/vault',
      signal: controller.signal,
    })
    await vi.waitFor(() => {
      expect(typeof payload?.onEvent.onmessage).toBe('function')
    })
    payload?.onEvent.onmessage?.({ event: 'started', id: 'job-1' })
    payload?.onEvent.onmessage?.({ event: 'stdout', data: 'so-far' })
    resolveSpawn?.('job-1')
    await Promise.resolve()
    await Promise.resolve()
    controller.abort()
    expect(cancels).toEqual([{ id: 'job-1' }])
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
    expect(invoke.mock.calls.filter((call) => call[0] === 'shell_exec_cancel')).toHaveLength(1)
    payload?.onEvent.onmessage?.(exit('cancel', null, false))
    await expect(pending).rejects.toBeInstanceOf(ShellAbortError)
    await expect(pending).rejects.toMatchObject({ output: { stdout: 'so-far', code: null } })
    expect(cancels).toEqual([{ id: 'job-1' }])
  })

  it('concatenates raw stdout chunks without inserting newlines', async () => {
    invoke.mockImplementation((_command: string, args: SpawnPayload) => {
      args.onEvent.onmessage?.({ event: 'stdout', data: 'foo' })
      args.onEvent.onmessage?.({ event: 'stdout', data: 'bar' })
      args.onEvent.onmessage?.({ event: 'stderr', data: 'a' })
      args.onEvent.onmessage?.({ event: 'stderr', data: 'b' })
      args.onEvent.onmessage?.(exit('exit', 0, false))
      return Promise.resolve('id-1')
    })
    const output = await shellBackend().exec({ command: 'printf hi', cwd: '/vault' })
    expect(output.stdout).toBe('foobar')
    expect(output.stderr).toBe('ab')
    expect(output.code).toBe(0)
  })

  it('maps a timeout exit to the caller timeoutSeconds', async () => {
    invoke.mockImplementation((_command: string, args: SpawnPayload) => {
      args.onEvent.onmessage?.({ event: 'stdout', data: 'partial' })
      args.onEvent.onmessage?.({ event: 'stderr', data: 'err' })
      args.onEvent.onmessage?.(exit('timeout', null, false))
      return Promise.resolve('id-1')
    })
    const pending = shellBackend().exec({ command: 'sleep 30', cwd: '/vault', timeoutSeconds: 0.0204 })
    await expect(pending).rejects.toBeInstanceOf(ShellTimeoutError)
    await expect(pending).rejects.toMatchObject({
      seconds: 0.0204,
      output: { stdout: 'partial', stderr: 'err' },
    })
  })

  it('keeps the original timeoutSeconds when dividing the milliseconds would drift', async () => {
    invoke.mockImplementation((_command: string, args: SpawnPayload) => {
      args.onEvent.onmessage?.(exit('timeout', null, false))
      return Promise.resolve('id-1')
    })
    const timeoutSeconds = 0.0021
    const pending = shellBackend().exec({ command: 'sleep 1', cwd: '/vault', timeoutSeconds })
    await expect(pending).rejects.toMatchObject({ seconds: timeoutSeconds })
    expect((timeoutSeconds * 1000) / 1000).not.toBe(timeoutSeconds)
  })

  it('does not invoke an empty command', async () => {
    await expect(shellBackend().exec({ command: ' \n\t', cwd: '/vault' })).rejects.toThrow('Command is empty')
    await expect(shellBackend().exec({ command: 'echo', cwd: '  ' })).rejects.toThrow('Working directory is empty')
    expect(invoke).not.toHaveBeenCalled()
  })

  it('does not probe PATH from JavaScript', async () => {
    invoke.mockImplementation((_command: string, args: SpawnPayload) => {
      args.onEvent.onmessage?.(exit('exit', 0, false))
      return Promise.resolve('id-1')
    })
    await shellBackend().exec({ command: 'echo hi', cwd: '/vault' })
    expect(invoke).toHaveBeenCalledTimes(1)
    for (const call of invoke.mock.calls) {
      const blob = JSON.stringify(call, (_key, value) => (typeof value === 'function' ? undefined : value))
      expect(blob).not.toContain('-lic')
      expect(blob).not.toContain('__STRIDE_PATH__')
    }
  })

  it('cancels once when the caller aborted before the id arrived', async () => {
    const controller = new AbortController()
    let payload: SpawnPayload | undefined
    const cancels: unknown[] = []
    let resolveSpawn: ((id: string) => void) | undefined
    const spawned = new Promise<string>((resolve) => {
      resolveSpawn = resolve
    })
    invoke.mockImplementation((command: string, args: unknown) => {
      if (command === 'shell_exec_cancel') {
        cancels.push(args)
        return Promise.resolve()
      }
      payload = args as SpawnPayload
      return spawned
    })
    const pending = shellBackend().exec({ command: 'sleep 30', cwd: '/vault', signal: controller.signal })
    await vi.waitFor(() => {
      expect(typeof payload?.onEvent.onmessage).toBe('function')
    })
    controller.abort()
    expect(cancels).toEqual([])
    payload?.onEvent.onmessage?.({ event: 'started', id: 'early' })
    expect(cancels).toEqual([{ id: 'early' }])
    resolveSpawn?.('early')
    await Promise.resolve()
    await Promise.resolve()
    expect(cancels).toEqual([{ id: 'early' }])
    payload?.onEvent.onmessage?.({ event: 'stdout', data: 'partial' })
    payload?.onEvent.onmessage?.(exit('cancel', null, false))
    await expect(pending).rejects.toMatchObject({ output: { stdout: 'partial' } })
  })

  it('ignores the channel end frame until an exit event', async () => {
    let emit: ((message: unknown) => void) | undefined
    invoke.mockImplementation((_command: string, args: SpawnPayload) => {
      emit = (message) => args.onEvent.onmessage?.(message)
      emit({ end: true })
      return Promise.resolve('id-1')
    })
    const pending = shellBackend().exec({ command: 'echo hi', cwd: '/vault' })
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
    emit?.({ event: 'stdout', data: 'ok' })
    emit?.(exit('exit', 3, false))
    await expect(pending).resolves.toMatchObject({ stdout: 'ok', code: 3, truncated: false })
    emit?.({ event: 'stdout', data: 'late' })
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
    expect(invoke).not.toHaveBeenCalled()
  })

  it('rejects with the error event message and rethrows invoke failures', async () => {
    invoke.mockImplementation((_command: string, args: SpawnPayload) => {
      args.onEvent.onmessage?.({ event: 'error', message: 'No shell is available' })
      return Promise.resolve('id-1')
    })
    await expect(shellBackend().exec({ command: 'echo hi', cwd: '/vault' })).rejects.toThrow('No shell is available')
    invoke.mockRejectedValue(new Error('spawn failed'))
    await expect(shellBackend().exec({ command: 'echo hi', cwd: '/vault' })).rejects.toThrow('spawn failed')
    invoke.mockRejectedValue('boom')
    await expect(shellBackend().exec({ command: 'echo hi', cwd: '/vault' })).rejects.toThrow('boom')
  })
})
