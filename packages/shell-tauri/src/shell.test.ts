import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ShellAbortError, ShellTimeoutError } from '@stride/platform'
import { resetShellSessionForTests, shellBackend } from './index.ts'

interface ShellCall {
  program: string
  args: string[]
  cwd?: string
  env?: Record<string, string>
  processGroup?: boolean
}

interface ShellResult {
  code: number | null
  stdout: string
  stderr: string
  hang?: boolean
  error?: string
}

const shell = vi.hoisted(() => {
  const calls: ShellCall[] = []
  let kills = 0
  let handler: (call: ShellCall) => ShellResult = () => ({ code: 0, stdout: '', stderr: '' })
  return {
    calls,
    get kills() {
      return kills
    },
    handle(next: (call: ShellCall) => ShellResult) {
      handler = next
    },
    reset() {
      calls.length = 0
      kills = 0
      handler = () => ({ code: 0, stdout: '', stderr: '' })
    },
    respond(call: ShellCall): ShellResult {
      calls.push(call)
      return handler(call)
    },
    killed() {
      kills += 1
    },
  }
})

vi.mock('@tauri-apps/plugin-shell', () => ({
  Command: {
    create(program: string, args: string | string[] = [], options?: { cwd?: string; env?: Record<string, string>; processGroup?: boolean }) {
      const argv = typeof args === 'string' ? [args] : [...args]
      const listeners = new Map<string, ((payload: unknown) => void)[]>()
      const command = {
        stdout: {
          on(event: string, listener: (payload: string) => void) {
            const list = listeners.get(`stdout:${event}`) ?? []
            list.push(listener as (payload: unknown) => void)
            listeners.set(`stdout:${event}`, list)
          },
        },
        stderr: {
          on(event: string, listener: (payload: string) => void) {
            const list = listeners.get(`stderr:${event}`) ?? []
            list.push(listener as (payload: unknown) => void)
            listeners.set(`stderr:${event}`, list)
          },
        },
        on(event: string, listener: (payload: unknown) => void) {
          const list = listeners.get(event) ?? []
          list.push(listener)
          listeners.set(event, list)
        },
        emit(event: string, payload: unknown) {
          for (const listener of listeners.get(event) ?? []) listener(payload)
        },
        async spawn() {
          const result = shell.respond({
            program,
            args: argv,
            cwd: options?.cwd,
            env: options?.env,
            processGroup: options?.processGroup,
          })
          if (result.error) {
            this.emit('error', result.error)
            return { async kill() { shell.killed() } }
          }
          const emitClose = () => {
            if (result.stdout) this.emit('stdout:data', result.stdout)
            if (result.stderr) this.emit('stderr:data', result.stderr)
            this.emit('close', { code: result.code, signal: null })
          }
          if (!result.hang) emitClose()
          return {
            async kill() {
              shell.killed()
              if (result.hang) emitClose()
            },
          }
        },
      }
      return command
    },
  },
}))

function pathOutput(path: string): ShellResult {
  return { code: 0, stdout: `\n__STRIDE_PATH__${path}`, stderr: '' }
}

const backend = shellBackend()

beforeEach(() => {
  shell.reset()
  resetShellSessionForTests()
})

describe('desktop shell', () => {
  it('runs bash in the vault and injects the login shell PATH', async () => {
    shell.handle((call) => {
      if (call.args[0] === '-lic') return pathOutput('/opt/homebrew/bin:/usr/bin')
      return { code: 0, stdout: 'hi', stderr: 'warn' }
    })
    const output = await backend.exec({ command: 'echo hi', cwd: '/vault' })
    expect(output).toMatchObject({ stdout: 'hi', stderr: 'warn', code: 0 })
    expect(shell.calls[0]).toMatchObject({ program: 'zsh', args: ['-lic', expect.stringContaining('__STRIDE_PATH__')] })
    expect(shell.calls[1]).toEqual({
      program: 'bash',
      args: ['-c', 'echo hi'],
      cwd: '/vault',
      env: { PATH: '/opt/homebrew/bin:/usr/bin' },
      processGroup: true,
    })
  })

  it('keeps a non-zero exit and reuses the probed PATH', async () => {
    shell.handle((call) => {
      if (call.args[0] === '-lic') return pathOutput('/usr/bin')
      return { code: 1, stdout: '', stderr: 'no' }
    })
    expect((await backend.exec({ command: 'false', cwd: '/vault' })).code).toBe(1)
    await backend.exec({ command: 'false', cwd: '/vault' })
    const probes = shell.calls.filter((call) => call.args[0] === '-lic')
    expect(probes).toHaveLength(1)
  })

  it('probes bash when zsh is not allowed', async () => {
    shell.handle((call) => {
      if (call.program === 'zsh') return { code: null, stdout: '', stderr: '', error: 'program not allowed on the configured shell scope: zsh' }
      if (call.args[0] === '-lic') return pathOutput('/usr/local/bin')
      return { code: 0, stdout: 'ok', stderr: '' }
    })
    await backend.exec({ command: 'true', cwd: '/vault' })
    expect(shell.calls.map((call) => call.program)).toEqual(['zsh', 'bash', 'bash'])
    expect(shell.calls[2]?.env).toEqual({ PATH: '/usr/local/bin' })
  })

  it('kills the process group when the timeout fires', async () => {
    shell.handle((call) => {
      if (call.args[0] === '-lic') return pathOutput('/usr/bin')
      return { code: null, stdout: 'partial', stderr: '', hang: true }
    })
    const pending = backend.exec({ command: 'sleep 30', cwd: '/vault', timeoutSeconds: 0.02 })
    await expect(pending).rejects.toBeInstanceOf(ShellTimeoutError)
    await expect(pending).rejects.toMatchObject({ seconds: 0.02, output: { stdout: 'partial' } })
    expect(shell.kills).toBe(1)
  })

  it('rejects an aborted command before the shell starts', async () => {
    const signal = new AbortController()
    signal.abort()
    await expect(backend.exec({ command: 'echo', cwd: '/vault', signal: signal.signal })).rejects.toBeInstanceOf(ShellAbortError)
    expect(shell.calls).toHaveLength(0)
  })

  it('kills a running command when the caller aborts', async () => {
    let started: (() => void) | undefined
    const ready = new Promise<void>((resolve) => { started = resolve })
    shell.handle((call) => {
      if (call.args[0] === '-lic') return pathOutput('/usr/bin')
      started?.()
      return { code: null, stdout: '', stderr: '', hang: true }
    })
    const signal = new AbortController()
    const pending = backend.exec({ command: 'sleep 30', cwd: '/vault', signal: signal.signal })
    await ready
    signal.abort()
    await expect(pending).rejects.toBeInstanceOf(ShellAbortError)
    expect(shell.kills).toBe(1)
  })
})
