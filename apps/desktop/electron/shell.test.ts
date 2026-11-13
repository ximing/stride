// @vitest-environment node
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawn as realSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import {
  clearShellProbeCache,
  commandEnvironment,
  disposeAllShellSessions,
  disposeShellSender,
  registerHostShell,
  setShellTestTimers,
  type HostShellDeps,
  type ShellIpcEvent,
  type ShellSender,
} from './shell.ts'
import type { RendererTrust } from './security.ts'

const DEV = 'http://127.0.0.1:1421/'
const trust: RendererTrust = { packaged: false, devUrl: DEV }
const TMP = join(import.meta.dirname, '../../verification/electron-migration-20261112/tmp')
const node = process.execPath

interface SentEvent {
  channel: string
  payload: unknown
}

function createSender(url = DEV) {
  const destroyedListeners: Array<() => void> = []
  let destroyed = false
  const sent: SentEvent[] = []
  const sender: ShellSender = {
    getURL: () => url,
    send(channel, payload) {
      if (!destroyed) sent.push({ channel, payload })
    },
    on(event, listener) {
      if (event === 'destroyed') destroyedListeners.push(listener)
    },
    isDestroyed: () => destroyed,
  }
  return {
    sender,
    sent,
    destroy() {
      destroyed = true
      for (const listener of destroyedListeners) listener()
    },
  }
}

function eventFor(sender: ShellSender): ShellIpcEvent {
  return { sender }
}

function payloads(sent: SentEvent[]): Array<Record<string, unknown>> {
  return sent.filter((item) => item.channel === 'shell:event').map((item) => item.payload as Record<string, unknown>)
}

function textOf(events: Array<Record<string, unknown>>, name: string): string {
  return events
    .filter((item) => item.event === name)
    .map((item) => (typeof item.data === 'string' ? item.data : ''))
    .join('')
}

async function untilTerminal(sent: SentEvent[], ms = 8000): Promise<Record<string, unknown>> {
  const start = Date.now()
  while (Date.now() - start < ms) {
    const found = payloads(sent).find((item) => item.event === 'exit' || item.event === 'error')
    if (found) return found
    await new Promise((resolve) => setTimeout(resolve, 15))
  }
  throw new Error(`shell session did not finish: ${JSON.stringify(payloads(sent))}`)
}

/** Skip login-shell startup. User commands still go to the real interpreter. */
function spawnWithFastProbe(command: string, args?: readonly string[], options?: SpawnOptions): ChildProcess {
  if (args?.[0] === '-lic') {
    return realSpawn(
      process.execPath,
      ['-e', 'process.stdout.write("\\n__STRIDE_PATH__"+process.env.PATH)'],
      options ?? {},
    )
  }
  return realSpawn(command, args ?? [], options ?? {})
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('host shell sessions', () => {
  let root = ''
  let handlers: Map<string, (event: ShellIpcEvent, payload?: unknown) => unknown>
  let owner = createSender()

  beforeEach(async () => {
    await mkdir(TMP, { recursive: true })
    root = await mkdtemp(join(TMP, 'e04a1-'))
    handlers = new Map()
    owner = createSender()
    registerHostShell({
      handle(channel, listener) {
        handlers.set(channel, listener)
      },
      getTrust: () => trust,
      spawn: spawnWithFastProbe as NonNullable<HostShellDeps['spawn']>,
    })
  })

  afterEach(async () => {
    setShellTestTimers()
    clearShellProbeCache()
    owner.destroy()
    if (root) await rm(root, { recursive: true, force: true })
  })

  function call(channel: string, payload?: unknown, sender = owner.sender) {
    const handler = handlers.get(channel)
    if (!handler) throw new Error(`missing ${channel}`)
    return handler(eventFor(sender), payload)
  }

  it('streams stdout and stderr and keeps a non-zero exit code', async () => {
    const id = await call('shell:spawn', {
      command: 'printf OUT; printf ERR >&2; exit 9',
      cwd: root,
    })
    expect(typeof id).toBe('string')
    const terminal = await untilTerminal(owner.sent)
    const events = payloads(owner.sent)
    expect(events[0]).toEqual({ id, event: 'started' })
    expect(textOf(events, 'stdout')).toBe('OUT')
    expect(textOf(events, 'stderr')).toBe('ERR')
    expect(terminal).toMatchObject({ id, event: 'exit', code: 9, truncated: false, reason: 'exit' })
    expect(events.filter((item) => item.event === 'exit' || item.event === 'error')).toHaveLength(1)
  })

  it('stops the process group on timeout', async () => {
    const id = await call('shell:spawn', { command: 'sleep 30', cwd: root, timeoutMs: 200 })
    const terminal = await untilTerminal(owner.sent)
    expect(terminal).toMatchObject({ id, event: 'exit', truncated: false, reason: 'timeout' })
  })

  it('lets only the owner cancel', async () => {
    const other = createSender()
    const id = await call('shell:spawn', { command: 'sleep 30', cwd: root })
    await expect(call('shell:cancel', { id }, other.sender)).rejects.toThrow('Rejected shell cancel')
    expect(payloads(other.sent)).toHaveLength(0)
    await call('shell:cancel', { id })
    const terminal = await untilTerminal(owner.sent)
    expect(terminal).toMatchObject({ id, event: 'exit', reason: 'cancel', truncated: false })
    await call('shell:cancel', { id })
    other.destroy()
  })

  it('caps combined output at 1MiB and marks the exit truncated', async () => {
    const id = await call('shell:spawn', {
      command: `"${node}" -e 'process.stdout.write("x".repeat(${1024 * 1024 + 64 * 1024}))'`,
      cwd: root,
    })
    const terminal = await untilTerminal(owner.sent, 15000)
    const stdout = textOf(payloads(owner.sent), 'stdout')
    expect(stdout.length).toBeLessThanOrEqual(1024 * 1024)
    expect(stdout.length).toBeGreaterThan(1024 * 1024 - 64 * 1024)
    expect(terminal).toMatchObject({ id, event: 'exit', truncated: true, reason: 'cap' })
    for (const item of payloads(owner.sent)) {
      if (typeof item.data === 'string') expect(Buffer.byteLength(item.data)).toBeLessThanOrEqual(8 * 1024)
    }
  })

  it('kills a child started by the shell when the group is cancelled', async () => {
    const pidFile = join(root, 'child.pid')
    const command = `"${node}" -e 'require("fs").writeFileSync(process.argv[1], String(process.pid)); setInterval(()=>{}, 500)' ${JSON.stringify(pidFile)} & wait`
    const id = await call('shell:spawn', { command, cwd: root })
    let pid = 0
    const start = Date.now()
    while (Date.now() - start < 5000) {
      try {
        pid = Number(await readFile(pidFile, 'utf8'))
        if (pid > 0) break
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
    }
    expect(pid).toBeGreaterThan(0)
    expect(alive(pid)).toBe(true)
    await call('shell:cancel', { id })
    const terminal = await untilTerminal(owner.sent)
    expect(terminal).toMatchObject({ id, reason: 'cancel' })
    const deadline = Date.now() + 3000
    while (alive(pid) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 30))
    }
    expect(alive(pid)).toBe(false)
  })

  it('rejects bad command, cwd, timeout, capacity, and untrusted senders', async () => {
    const stranger = createSender('http://evil.example/')
    await expect(call('shell:spawn', { command: 'printf hi', cwd: root }, stranger.sender)).rejects.toThrow(
      'untrusted renderer',
    )
    await expect(call('shell:spawn', { command: '   ', cwd: root })).rejects.toThrow('Command is empty')
    await expect(call('shell:spawn', { command: 'x'.repeat(256 * 1024 + 1), cwd: root })).rejects.toThrow(
      'Command is too long',
    )
    await expect(call('shell:spawn', { command: 'printf hi', cwd: 'relative' })).rejects.toThrow('absolute directory')
    const file = join(root, 'note.txt')
    await writeFile(file, 'nope')
    await expect(call('shell:spawn', { command: 'printf hi', cwd: file })).rejects.toThrow('absolute directory')
    await expect(call('shell:spawn', { command: 'printf hi', cwd: root, timeoutMs: -1 })).rejects.toThrow(
      'invalid timeout',
    )
    await expect(call('shell:spawn', { command: 'printf hi', cwd: root, timeoutMs: Number.POSITIVE_INFINITY })).rejects.toThrow(
      'invalid timeout',
    )

    const ids: string[] = []
    for (let index = 0; index < 8; index += 1) {
      ids.push(String(await call('shell:spawn', { command: 'sleep 30', cwd: root })))
    }
    await expect(call('shell:spawn', { command: 'sleep 30', cwd: root })).rejects.toThrow('too many shell processes')
    for (const id of ids) await call('shell:cancel', { id })
    await untilTerminal(owner.sent)
  })

  it('kills the process group when the sender is destroyed', async () => {
    const pidFile = join(root, 'gone.pid')
    const command = `"${node}" -e 'require("fs").writeFileSync(process.argv[1], String(process.pid)); setInterval(()=>{}, 500)' ${JSON.stringify(pidFile)} & wait`
    await call('shell:spawn', { command, cwd: root })
    let pid = 0
    const start = Date.now()
    while (Date.now() - start < 5000) {
      try {
        pid = Number(await readFile(pidFile, 'utf8'))
        if (pid > 0) break
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
    }
    expect(alive(pid)).toBe(true)
    owner.destroy()
    const deadline = Date.now() + 3000
    while (alive(pid) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 30))
    }
    expect(alive(pid)).toBe(false)
  })

  describe('login PATH and lifecycle', () => {
    const LOGIN_PATH = '/opt/stride-login/bin'
    let probePids: number[] = []

    function useSpawn(mode: 'hit' | 'miss' | 'hang') {
      probePids = []
      const userArgs: string[][] = []
      let probes = 0
      clearShellProbeCache()
      registerHostShell({
        handle(channel, listener) {
          handlers.set(channel, listener)
        },
        getTrust: () => trust,
        spawn: ((_command: string, args?: readonly string[], options?: { cwd?: string | URL; env?: NodeJS.ProcessEnv; detached?: boolean }) => {
          const argv = [...(args ?? [])].map(String)
          if (argv[0] === '-lic') {
            probes += 1
            if (mode === 'hang') {
              const child = realSpawn(node, ['-e', 'setInterval(() => {}, 1000)'], {
                cwd: options?.cwd,
                env: options?.env,
                detached: process.platform !== 'win32',
                shell: false,
                stdio: ['ignore', 'pipe', 'pipe'],
              }) as ChildProcess
              if (typeof child.pid === 'number') probePids.push(child.pid)
              return child
            }
            const script =
              mode === 'hit'
                ? `process.stdout.write("\\n__STRIDE_PATH__${LOGIN_PATH}")`
                : 'process.stderr.write("probe-failed"); process.exit(1)'
            return realSpawn(node, ['-e', script], {
              cwd: options?.cwd,
              env: options?.env,
              shell: false,
              stdio: ['ignore', 'pipe', 'pipe'],
            }) as ChildProcess
          }
          userArgs.push(argv)
          return realSpawn(node, ['-e', 'process.stdout.write(process.env.PATH || "")'], {
            cwd: options?.cwd,
            env: options?.env,
            detached: options?.detached,
            shell: false,
            stdio: ['ignore', 'pipe', 'pipe'],
          })
        }) as NonNullable<Parameters<typeof registerHostShell>[0]['spawn']>,
      })
      return { userArgs, probes: () => probes }
    }

    afterEach(() => {
      clearShellProbeCache()
      for (const pid of probePids) {
        try {
          process.kill(-pid, 'SIGKILL')
        } catch {
          try {
            process.kill(pid, 'SIGKILL')
          } catch {
            // Already gone.
          }
        }
      }
    })

    async function waitStarted(): Promise<string> {
      const start = Date.now()
      while (Date.now() - start < 5000) {
        const started = payloads(owner.sent).find((item) => item.event === 'started')
        if (started && typeof started.id === 'string') return started.id
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      throw new Error('shell session did not start')
    }

    /** `started` is sent before the login probe spawns. Cancel only after it is running. */
    async function waitForProbe(readProbes: () => number): Promise<void> {
      const start = Date.now()
      while (Date.now() - start < 5000) {
        if (readProbes() >= 1) return
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      throw new Error('login probe did not start')
    }

    it('uses the probed PATH and probes once', async () => {
      const spawned = useSpawn('hit')
      const first = await call('shell:spawn', { command: 'printf "$PATH"', cwd: root })
      const firstExit = await untilTerminal(owner.sent)
      expect(firstExit).toMatchObject({ id: first, event: 'exit', reason: 'exit' })
      expect(textOf(payloads(owner.sent), 'stdout')).toBe(LOGIN_PATH)
      expect(textOf(payloads(owner.sent), 'stdout')).not.toContain('__STRIDE_PATH__')

      owner.sent.length = 0
      const second = await call('shell:spawn', { command: 'printf "$PATH"', cwd: root })
      const secondExit = await untilTerminal(owner.sent)
      expect(secondExit).toMatchObject({ id: second, event: 'exit', reason: 'exit' })
      expect(textOf(payloads(owner.sent), 'stdout')).toBe(LOGIN_PATH)
      expect(spawned.userArgs).toHaveLength(2)
      expect(spawned.userArgs.every((argv) => argv[0] === '-c')).toBe(true)
      expect(spawned.probes()).toBe(1)
    })

    it('falls back to the current PATH when the probe fails', async () => {
      useSpawn('miss')
      const id = await call('shell:spawn', { command: 'printf "$PATH"', cwd: root })
      const terminal = await untilTerminal(owner.sent)
      expect(terminal).toMatchObject({ id, event: 'exit', reason: 'exit' })
      const events = payloads(owner.sent)
      expect(textOf(events, 'stdout')).toBe(process.env.PATH ?? '')
      expect(textOf(events, 'stdout') + textOf(events, 'stderr')).not.toContain('__STRIDE_PATH__')
      expect(textOf(events, 'stderr')).not.toContain('probe-failed')
    })

    it('does not start the user command when cancel arrives during the probe', async () => {
      const spawned = useSpawn('hang')
      const pending = call('shell:spawn', { command: 'printf "$PATH"', cwd: root })
      const id = await waitStarted()
      await waitForProbe(spawned.probes)
      await call('shell:cancel', { id })
      const terminal = await untilTerminal(owner.sent)
      expect(terminal).toMatchObject({ id, event: 'exit', reason: 'cancel' })
      await pending
      expect(spawned.userArgs).toHaveLength(0)
      expect(spawned.probes()).toBe(1)
      expect(probePids.length).toBeGreaterThan(0)
      const deadline = Date.now() + 3000
      while (probePids.some((pid) => alive(pid)) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      expect(probePids.some((pid) => alive(pid))).toBe(false)
    })

    it('drops only the navigating sender', async () => {
      const other = createSender()
      const ownerPidFile = join(root, 'owner.pid')
      const otherPidFile = join(root, 'other.pid')
      const commandFor = (pidFile: string) =>
        `"${node}" -e 'require("fs").writeFileSync(process.argv[1], String(process.pid)); setInterval(()=>{}, 500)' ${JSON.stringify(pidFile)} & wait`
      await call('shell:spawn', { command: commandFor(ownerPidFile), cwd: root })
      await call('shell:spawn', { command: commandFor(otherPidFile), cwd: root }, other.sender)
      const ownerPid = await readPid(ownerPidFile)
      const otherPid = await readPid(otherPidFile)
      const ownerEvents = owner.sent.length
      disposeShellSender(owner.sender)
      await settled(ownerPid, false)
      expect(alive(otherPid)).toBe(true)
      expect(owner.sent.length).toBe(ownerEvents)
      expect(payloads(owner.sent).some((item) => item.event === 'exit' || item.event === 'error')).toBe(false)
      await call('shell:cancel', { id: payloads(other.sent)[0]?.id }, other.sender)
      other.destroy()
    })

    it('kills every session on before-quit', async () => {
      const other = createSender()
      const ownerPidFile = join(root, 'quit-owner.pid')
      const otherPidFile = join(root, 'quit-other.pid')
      const commandFor = (pidFile: string) =>
        `"${node}" -e 'require("fs").writeFileSync(process.argv[1], String(process.pid)); setInterval(()=>{}, 500)' ${JSON.stringify(pidFile)} & wait`
      await call('shell:spawn', { command: commandFor(ownerPidFile), cwd: root })
      await call('shell:spawn', { command: commandFor(otherPidFile), cwd: root }, other.sender)
      const ownerPid = await readPid(ownerPidFile)
      const otherPid = await readPid(otherPidFile)
      disposeAllShellSessions()
      await settled(ownerPid, false)
      await settled(otherPid, false)
      expect(alive(ownerPid)).toBe(false)
      expect(alive(otherPid)).toBe(false)
      other.destroy()
    })
  })

  describe('bounded stop and narrow spawn edges', () => {
    function fastProbe(command: string, args?: readonly string[], options?: SpawnOptions): ChildProcess {
      if (args?.[0] === '-lic') {
        return realSpawn(node, ['-e', 'process.stdout.write("\\n__STRIDE_PATH__"+process.env.PATH)'], options ?? {})
      }
      return realSpawn(command, args ?? [], options ?? {})
    }

    function silentChild(pid: number): ChildProcess & { stdout: EventEmitter; stderr: EventEmitter } {
      const stdout = new EventEmitter()
      const stderr = new EventEmitter()
      const child = new EventEmitter() as EventEmitter & {
        pid: number
        stdout: EventEmitter
        stderr: EventEmitter
        kill: () => void
      }
      child.pid = pid
      child.stdout = stdout
      child.stderr = stderr
      child.kill = () => {}
      return child as unknown as ChildProcess & { stdout: EventEmitter; stderr: EventEmitter }
    }

    it('reaches one terminal and frees the slot when close never arrives', async () => {
      setShellTestTimers({ killCloseFallbackMs: 25 })
      const children: Array<ChildProcess & { stdout: EventEmitter; stderr: EventEmitter }> = []
      registerHostShell({
        handle(channel, listener) {
          handlers.set(channel, listener)
        },
        getTrust: () => trust,
        spawn: ((command: string, args?: readonly string[], options?: SpawnOptions) => {
          if (args?.[0] === '-lic') return fastProbe(command, args, options)
          const child = silentChild(2_100_000_000 + children.length)
          children.push(child)
          return child
        }) as NonNullable<HostShellDeps['spawn']>,
      })

      const ids: string[] = []
      for (let index = 0; index < 8; index += 1) {
        ids.push(String(await call('shell:spawn', { command: 'sleep 30', cwd: root })))
      }
      await expect(call('shell:spawn', { command: 'sleep 30', cwd: root })).rejects.toThrow('too many shell processes')
      for (const id of ids) await call('shell:cancel', { id })
      await expect(call('shell:spawn', { command: 'sleep 30', cwd: root })).rejects.toThrow('too many shell processes')

      const deadline = Date.now() + 1000
      while (payloads(owner.sent).filter((item) => item.event === 'exit').length < 8 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      const exits = payloads(owner.sent).filter((item) => item.event === 'exit')
      expect(exits).toHaveLength(8)
      expect(exits.every((item) => item.reason === 'cancel' && item.code === null)).toBe(true)

      const again = String(await call('shell:spawn', { command: 'sleep 30', cwd: root }))
      expect(ids).not.toContain(again)
      await call('shell:cancel', { id: again })
      const againDeadline = Date.now() + 1000
      while (
        payloads(owner.sent).filter((item) => item.id === again && item.event === 'exit').length < 1 &&
        Date.now() < againDeadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      expect(payloads(owner.sent).filter((item) => item.id === again && item.event === 'exit')).toHaveLength(1)
    })

    it('resolves a probe that is killed and never closes', async () => {
      setShellTestTimers({ probeTimeoutMs: 20, killCloseFallbackMs: 25 })
      let userSpawns = 0
      registerHostShell({
        handle(channel, listener) {
          handlers.set(channel, listener)
        },
        getTrust: () => trust,
        spawn: ((command: string, args?: readonly string[], options?: SpawnOptions) => {
          if (args?.[0] === '-lic') return silentChild(2_100_000_099)
          userSpawns += 1
          return fastProbe(command, args, options)
        }) as NonNullable<HostShellDeps['spawn']>,
      })
      const id = await call('shell:spawn', { command: 'printf hi', cwd: root })
      const terminal = await untilTerminal(owner.sent)
      expect(userSpawns).toBe(1)
      expect(terminal).toMatchObject({ id, event: 'exit' })
    })

    it('kills the positive pid when the process group is already gone', async () => {
      const kills: number[] = []
      const original = process.kill
      process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
        if (pid === -424242 || pid === 424242) {
          kills.push(pid)
          if (pid < 0) {
            const error = new Error('no such process group') as NodeJS.ErrnoException
            error.code = 'ESRCH'
            throw error
          }
          return true
        }
        return original.call(process, pid, signal as NodeJS.Signals)
      }) as typeof process.kill
      try {
        registerHostShell({
          handle(channel, listener) {
            handlers.set(channel, listener)
          },
          getTrust: () => trust,
          spawn: ((command: string, args?: readonly string[], options?: SpawnOptions) => {
            if (args?.[0] === '-lic') return fastProbe(command, args, options)
            return silentChild(424242)
          }) as NonNullable<HostShellDeps['spawn']>,
        })
        const id = await call('shell:spawn', { command: 'sleep 30', cwd: root })
        await call('shell:cancel', { id })
        expect(kills).toEqual([-424242, 424242])
      } finally {
        process.kill = original
      }
    })

    it('flushes a partial decoder chunk when the session stops', async () => {
      let held: (ChildProcess & { stdout: EventEmitter; stderr: EventEmitter }) | null = null
      registerHostShell({
        handle(channel, listener) {
          handlers.set(channel, listener)
        },
        getTrust: () => trust,
        spawn: ((command: string, args?: readonly string[], options?: SpawnOptions) => {
          if (args?.[0] === '-lic') return fastProbe(command, args, options)
          held = silentChild(424243)
          return held
        }) as NonNullable<HostShellDeps['spawn']>,
      })
      const id = await call('shell:spawn', { command: 'printf hi', cwd: root })
      expect(held).not.toBeNull()
      held!.stdout.emit('data', Buffer.from([0xc3]))
      await call('shell:cancel', { id })
      expect(textOf(payloads(owner.sent), 'stdout')).toBe('\uFFFD')
      held!.emit('close', 0)
      expect(payloads(owner.sent).filter((item) => item.event === 'exit')).toHaveLength(1)
      expect(textOf(payloads(owner.sent), 'stdout')).toBe('\uFFFD')
    })

    it('clamps a timeout above the 32-bit timer max instead of firing immediately', async () => {
      const id = await call('shell:spawn', { command: 'sleep 30', cwd: root, timeoutMs: 2_147_483_648 })
      await new Promise((resolve) => setTimeout(resolve, 80))
      expect(payloads(owner.sent).some((item) => item.event === 'exit' || item.event === 'error')).toBe(false)
      await call('shell:cancel', { id })
      const terminal = await untilTerminal(owner.sent)
      expect(terminal).toMatchObject({ id, event: 'exit', reason: 'cancel' })
    })

    it('emits an error terminal when spawn throws after started', async () => {
      let userSpawns = 0
      registerHostShell({
        handle(channel, listener) {
          handlers.set(channel, listener)
        },
        getTrust: () => trust,
        spawn: ((command: string, args?: readonly string[], options?: SpawnOptions) => {
          if (args?.[0] === '-lic') return fastProbe(command, args, options)
          userSpawns += 1
          if (userSpawns === 1) throw new Error('spawn failed')
          return fastProbe(command, args, options)
        }) as NonNullable<HostShellDeps['spawn']>,
      })
      await expect(call('shell:spawn', { command: 'printf hi', cwd: root })).rejects.toThrow('spawn failed')
      const events = payloads(owner.sent)
      expect(events.map((item) => item.event)).toEqual(['started', 'error'])
      expect(events[1]).toMatchObject({ event: 'error', message: 'spawn failed' })
      owner.sent.length = 0
      const id = await call('shell:spawn', { command: 'printf hi', cwd: root })
      const terminal = await untilTerminal(owner.sent)
      expect(terminal).toMatchObject({ id, event: 'exit', code: 0 })
    })
  })
})

describe('commandEnvironment', () => {
  it('writes PATH on POSIX and drops every other spelling', () => {
    const env = commandEnvironment(
      { PATH: '/old', Path: '/windows', path: '/lower', HOME: '/home', PathExtra: 'keep' },
      '/opt/stride-login/bin',
      'linux',
    )
    expect(env).toEqual({ HOME: '/home', PathExtra: 'keep', PATH: '/opt/stride-login/bin' })
  })

  it('writes Path on Windows and drops PATH', () => {
    const env = commandEnvironment(
      { PATH: '/old', Path: 'C:\\Windows', HOME: '/home' },
      'C:\\login\\bin',
      'win32',
    )
    expect(env).toEqual({ HOME: '/home', Path: 'C:\\login\\bin' })
    expect(Object.keys(env).some((key) => key !== 'Path' && key.toLowerCase() === 'path')).toBe(false)
  })

  it('keeps one inherited PATH key when there is no override', () => {
    expect(commandEnvironment({ path: '/lower', HOME: '/home' }, undefined, 'linux')).toEqual({
      HOME: '/home',
      PATH: '/lower',
    })
    expect(commandEnvironment({ PATH: 'C:\\old', Path: 'C:\\Windows' }, undefined, 'win32')).toEqual({
      Path: 'C:\\Windows',
    })
  })
})

async function readPid(pidFile: string): Promise<number> {
  const start = Date.now()
  while (Date.now() - start < 5000) {
    try {
      const pid = Number(await readFile(pidFile, 'utf8'))
      if (pid > 0) return pid
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }
  throw new Error(`missing pid file ${pidFile}`)
}

async function settled(pid: number, expectedAlive: boolean): Promise<void> {
  const deadline = Date.now() + 3000
  while (alive(pid) !== expectedAlive && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 30))
  }
}
