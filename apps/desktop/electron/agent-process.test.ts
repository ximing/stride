// @vitest-environment node
import { spawn as realSpawn, type SpawnOptions } from 'node:child_process'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EXTERNAL_AGENT_SPAWN, VAULT_CLI_RULES } from '@stride/platform'
import {
  disposeAllAgentProcesses,
  registerHostAgent,
  type HostAgentDeps,
} from './agent-process.ts'
import type { RendererTrust } from './security.ts'
import type { ShellIpcEvent, ShellSender } from './shell.ts'

const DEV = 'http://127.0.0.1:1421/'
const trust: RendererTrust = { packaged: false, devUrl: DEV }

interface SentEvent {
  channel: string
  payload: unknown
}

interface RecordedSpawn {
  command: string
  args: readonly string[]
  cwd?: string
  path?: string
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

describe('host agent processes', () => {
  let root = ''
  let handlers: Map<string, (event: ShellIpcEvent, payload?: unknown) => unknown>
  let owner = createSender()
  let recorded: RecordedSpawn[] = []

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'stride-agent-'))
    handlers = new Map()
    owner = createSender()
    recorded = []
    const spawn = (command: string, args?: readonly string[], options?: SpawnOptions) => {
      const envPath = options?.env?.PATH ?? options?.env?.Path
      recorded.push({
        command,
        args: [...(args ?? [])],
        cwd: typeof options?.cwd === 'string' ? options.cwd : undefined,
        path: typeof envPath === 'string' ? envPath : undefined,
      })
      const script = `
        process.stdin.setEncoding('utf8')
        process.stdin.on('data', (chunk) => process.stdout.write(chunk))
        setInterval(() => {}, 1000)
      `
      return realSpawn(process.execPath, ['-e', script], options ?? {})
    }
    registerHostAgent({
      handle(channel, listener) {
        handlers.set(channel, listener)
      },
      getTrust: () => trust,
      spawn: spawn as NonNullable<HostAgentDeps['spawn']>,
      loginPath: async () => undefined,
    })
  })

  afterEach(async () => {
    disposeAllAgentProcesses()
    owner.destroy()
    if (root) await rm(root, { recursive: true, force: true })
  })

  function call(channel: string, payload?: unknown, sender = owner.sender) {
    const handler = handlers.get(channel)
    if (!handler) throw new Error(`missing ${channel}`)
    return handler(eventFor(sender), payload)
  }

  function agentEvents(): Array<Record<string, unknown>> {
    return owner.sent
      .filter((item) => item.channel === 'agent:event')
      .map((item) => item.payload as Record<string, unknown>)
  }

  it('rejects a model override and an unknown command before spawn', async () => {
    await expect(call('agent:spawn', {
      command: 'claude',
      args: [...EXTERNAL_AGENT_SPAWN.claude.args, '--model', 'opus'],
      cwd: root,
    })).rejects.toThrow(/model/i)
    await expect(call('agent:spawn', {
      command: 'bash',
      args: ['-lc', 'true'],
      cwd: root,
    })).rejects.toThrow(/command/i)
    expect(recorded).toEqual([])
  })

  it('spawns the exact allowlisted argv and echoes stdin back to the renderer', async () => {
    const args = [...EXTERNAL_AGENT_SPAWN.codex.args]
    const id = await call('agent:spawn', { command: 'codex', args, cwd: root })
    expect(typeof id).toBe('string')
    expect(recorded).toEqual([{ command: 'codex', args, cwd: root, path: process.env.PATH }])
    await call('agent:write', { id, data: 'hello-agent\n' })
    const start = Date.now()
    let stdout = ''
    while (Date.now() - start < 4000 && !stdout.includes('hello-agent')) {
      stdout = agentEvents()
        .filter((item) => item.event === 'stdout')
        .map((item) => (typeof item.data === 'string' ? item.data : ''))
        .join('')
      if (!stdout.includes('hello-agent')) await new Promise((resolve) => setTimeout(resolve, 15))
    }
    expect(stdout).toContain('hello-agent')
    await call('agent:kill', { id })
    const killed = Date.now()
    let exited = false
    while (Date.now() - killed < 4000 && !exited) {
      exited = agentEvents().some((item) => item.event === 'exit' && item.id === id)
      if (!exited) await new Promise((resolve) => setTimeout(resolve, 15))
    }
    expect(exited).toBe(true)
  })

  it('spawns an absolute executable whose name matches the argv and puts its directory on PATH', async () => {
    const command = join(root, 'bin', 'codex')
    const args = [...EXTERNAL_AGENT_SPAWN.codex.args]
    await call('agent:spawn', { command, args, cwd: root })
    expect(recorded[0]?.command).toBe(command)
    expect(recorded[0]?.args).toEqual(args)
    expect(recorded[0]?.path?.split(delimiter)[0]).toBe(join(root, 'bin'))

    const tilde = await call('agent:spawn', {
      command: '~/bin/codex',
      args,
      cwd: root,
    })
    expect(typeof tilde).toBe('string')
    expect(recorded[1]?.command).toBe(join(homedir(), 'bin', 'codex'))
  })

  it('rejects a foreign basename, a relative path, and a model override on an absolute command', async () => {
    const codexArgs = [...EXTERNAL_AGENT_SPAWN.codex.args]
    await expect(call('agent:spawn', {
      command: '/tmp/bash',
      args: codexArgs,
      cwd: root,
    })).rejects.toThrow(/command/i)
    await expect(call('agent:spawn', {
      command: '../codex',
      args: codexArgs,
      cwd: root,
    })).rejects.toThrow(/command/i)
    await expect(call('agent:spawn', {
      command: join(root, 'bin', 'codex'),
      args: [...codexArgs, '--model', 'gpt-5'],
      cwd: root,
    })).rejects.toThrow(/model/i)
    await expect(call('agent:spawn', {
      command: join(root, 'bin', 'codex'),
      args: [...EXTERNAL_AGENT_SPAWN.claude.args],
      cwd: root,
    })).rejects.toThrow(/argument/i)
    expect(recorded).toEqual([])
  })

  it('spawns a claude rules suffix and an optional resume handle without dropping them', async () => {
    const withRules = [...EXTERNAL_AGENT_SPAWN.claude.args, '--append-system-prompt', VAULT_CLI_RULES]
    await call('agent:spawn', { command: 'claude', args: withRules, cwd: root })
    expect(recorded[0]?.args).toEqual(withRules)
    const withResume = [...withRules, '--resume', 'sess_1']
    await call('agent:spawn', { command: 'claude', args: withResume, cwd: root })
    expect(recorded[1]?.args).toEqual(withResume)
    await expect(call('agent:spawn', {
      command: 'claude',
      args: [...EXTERNAL_AGENT_SPAWN.claude.args, '--append-system-prompt', 'other prompt'],
      cwd: root,
    })).rejects.toThrow(/argument/i)
    await expect(call('agent:spawn', {
      command: 'codex',
      args: [...EXTERNAL_AGENT_SPAWN.codex.args, '--append-system-prompt', VAULT_CLI_RULES],
      cwd: root,
    })).rejects.toThrow(/argument/i)
    expect(recorded).toHaveLength(2)
  })

  it('returns detected executables from agent:which', async () => {
    registerHostAgent({
      handle(channel, listener) {
        handlers.set(channel, listener)
      },
      getTrust: () => trust,
      loginPath: async () => undefined,
      whichAgents: async () => ({ grok: '/opt/grok', claude: null, codex: '/opt/codex' }),
    })
    await expect(call('agent:which')).resolves.toEqual({
      grok: '/opt/grok',
      claude: null,
      codex: '/opt/codex',
    })
  })

  it('probes a missing absolute path and does not throw for a bare command', async () => {
    const command = join(root, 'claude')
    await writeFile(command, '')
    await expect(call('agent:probe', { command, mode: 'claude' })).resolves.toEqual({
      found: true,
      resolved: command,
    })
    await expect(call('agent:probe', { command: '/opt/no-such-claude', mode: 'claude' })).resolves.toEqual({
      found: false,
      resolved: '',
    })
    await expect(call('agent:probe', { command: 'claude', mode: 'claude' })).resolves.toEqual({
      found: false,
      resolved: '',
    })
    await expect(call('agent:probe', { command: join(root, 'grok'), mode: 'claude' })).resolves.toEqual({
      found: false,
      resolved: '',
    })
    expect(recorded).toEqual([])
  })

  it('resolves a bare name from the login PATH without spawning', async () => {
    const bin = join(root, 'bin')
    await mkdir(bin)
    const claude = join(bin, 'claude')
    await writeFile(claude, '')
    await chmod(claude, 0o755)
    registerHostAgent({
      handle(channel, listener) {
        handlers.set(channel, listener)
      },
      getTrust: () => trust,
      loginPath: async () => bin,
      spawn: (() => {
        throw new Error('probe must not spawn')
      }) as NonNullable<HostAgentDeps['spawn']>,
    })
    await expect(call('agent:probe', { command: '', mode: 'claude' })).resolves.toEqual({
      found: true,
      resolved: claude,
    })
    await expect(call('agent:probe', { command: '  claude  ', mode: 'claude' })).resolves.toEqual({
      found: true,
      resolved: claude,
    })
    await expect(call('agent:probe', { command: 'claude', mode: 'grok' })).resolves.toEqual({
      found: false,
      resolved: '',
    })
  })
})
