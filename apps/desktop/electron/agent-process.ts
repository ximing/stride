import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, delimiter, dirname, isAbsolute, join, sep } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { acceptedAgentArgv, agentSpawnSpec, isExternalAgentMode, spawnArgsOverrideModel, type ExternalAgentMode } from '@stride/platform'
import { detectAgentExecutables, type DetectedAgentExecutables } from './agent-which.ts'
import { assertTrustedSender, type RendererTrust } from './security.ts'
import { commandEnvironment, loginPathFor, type ShellIpcEvent, type ShellSender } from './shell.ts'

export interface HostAgentDeps {
  handle(channel: string, listener: (event: ShellIpcEvent, payload?: unknown) => unknown): void
  getTrust(): RendererTrust
  /** Test seam. Production uses `node:child_process` spawn. */
  spawn?: typeof nodeSpawn
  /** Test seam. Production probes the login shell PATH. */
  loginPath?: (cwd: string) => Promise<string | undefined>
  /** Test seam. Production scans PATH and version-manager bins. */
  whichAgents?: () => Promise<DetectedAgentExecutables>
}

interface AgentSession {
  id: string
  sender: ShellSender
  child: ChildProcess | null
  pid: number | null
  ended: boolean
  stdout: StringDecoder
  stderr: StringDecoder
  stderrTail: string
  spawnError: string
}

const MAX_SESSIONS = 4
const MAX_WRITE_BYTES = 1024 * 1024
const MAX_CHUNK = 8 * 1024

const sessions = new Map<string, AgentSession>()
const destroyBound = new WeakSet<ShellSender>()
const EXECUTABLE_SUFFIX = /\.(exe|cmd)$/i

let spawnProcess: typeof nodeSpawn = nodeSpawn
let resolveLoginPath: (cwd: string) => Promise<string | undefined> = loginPathFor
let resolveWhichAgents: () => Promise<DetectedAgentExecutables> = detectFromLoginPath

function commandStem(command: string): ExternalAgentMode | null {
  const stem = basename(command).replace(EXECUTABLE_SUFFIX, '')
  return isExternalAgentMode(stem) ? stem : null
}

function expandHome(command: string): string {
  if (command.startsWith('~/') || command.startsWith('~\\')) return join(homedir(), command.slice(2))
  return command
}

function executableNames(mode: ExternalAgentMode): string[] {
  if (process.platform === 'win32') return [mode, `${mode}.exe`, `${mode}.cmd`]
  return [mode]
}

async function isExecutableFile(file: string): Promise<boolean> {
  // Skip the nested Codex vendor binary, same as agent:which.
  if (file.split(sep).includes('node_modules')) return false
  try {
    const info = await stat(file)
    if (!info.isFile()) return false
    if (process.platform === 'win32') return true
    return (info.mode & 0o111) !== 0
  } catch {
    return false
  }
}

async function findModeOnLoginPath(mode: ExternalAgentMode): Promise<{ found: boolean; resolved: string }> {
  const miss = { found: false, resolved: '' }
  const pathEnv = await resolveLoginPath(homedir()).catch(() => undefined)
  if (!pathEnv) return miss
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue
    for (const name of executableNames(mode)) {
      const file = join(dir, name)
      if (await isExecutableFile(file)) return { found: true, resolved: file }
    }
  }
  return miss
}

/** Read-only. Empty and bare names use the login PATH. A matching absolute path is stat'd, not realpath'd. */
async function probeExecutable(command: string, mode: ExternalAgentMode): Promise<{ found: boolean; resolved: string }> {
  const miss = { found: false, resolved: '' }
  if (command.includes('\0') || command.length > 4096) return miss
  const trimmed = command.trim()
  if (trimmed === '' || trimmed === mode) return findModeOnLoginPath(mode)
  const tilde = trimmed.startsWith('~/') || trimmed.startsWith('~\\')
  const expanded = expandHome(trimmed)
  if (!tilde && !isAbsolute(expanded)) return miss
  if (commandStem(expanded) !== mode) return miss
  try {
    await stat(expanded)
  } catch {
    return miss
  }
  return { found: true, resolved: expanded }
}

async function detectFromLoginPath(): Promise<DetectedAgentExecutables> {
  const pathEnv = await resolveLoginPath(homedir()).catch(() => undefined)
  return detectAgentExecutables({ home: homedir(), pathEnv, fnmDir: process.env.FNM_DIR })
}

function killGroup(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) return
  if (process.platform === 'win32') {
    const killer = nodeSpawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
      shell: false,
      windowsHide: true,
      stdio: 'ignore',
    })
    killer.unref()
    return
  }
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

function requestRecord(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Rejected invalid agent request')
  return payload as Record<string, unknown>
}

async function checkCwd(value: unknown): Promise<string> {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096 || value.includes('\0') || !isAbsolute(value)) {
    throw new Error('Working directory must be an absolute directory')
  }
  let info
  try {
    info = await stat(value)
  } catch {
    throw new Error('Working directory must be an absolute directory')
  }
  if (!info.isDirectory()) throw new Error('Working directory must be an absolute directory')
  return value
}

function acceptedArgs(command: unknown, args: unknown): { command: string; args: string[] } {
  if (typeof command !== 'string' || command.length === 0 || command.length > 4096 || command.includes('\0')) {
    throw new Error('Rejected agent command')
  }
  const expanded = expandHome(command)
  const mode = isExternalAgentMode(expanded) ? expanded : isAbsolute(expanded) ? commandStem(expanded) : null
  if (!mode) throw new Error('Rejected agent command')
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) throw new Error('Rejected agent arguments')
  const list = args as string[]
  if (spawnArgsOverrideModel(list)) throw new Error('Rejected agent model override')
  const accepted = acceptedAgentArgv(mode, list)
  if (!accepted) throw new Error('Rejected agent arguments')
  const spec = agentSpawnSpec(mode)
  // `accepted` is the full validated argv, including a Claude rules or --resume suffix.
  return { command: isExternalAgentMode(expanded) ? spec.command : expanded, args: accepted }
}

function environmentFor(pathOverride: string | undefined, command: string): NodeJS.ProcessEnv {
  const env = commandEnvironment(process.env, pathOverride)
  if (!isAbsolute(command)) return env
  // Node CLIs such as fnm's codex use `#!/usr/bin/env node`. The directory of
  // the chosen binary has to win, or PATH's default node runs the script.
  const dir = dirname(command)
  const key = process.platform === 'win32' ? 'Path' : 'PATH'
  const current = env[key]
  env[key] = current ? `${dir}${delimiter}${current}` : dir
  return env
}

function emit(session: AgentSession, payload: Record<string, unknown>): void {
  if (session.sender.isDestroyed()) return
  try {
    session.sender.send('agent:event', { id: session.id, ...payload })
  } catch {
    // The renderer is gone.
  }
}

function emitStdout(session: AgentSession, text: string): void {
  if (!text || session.ended) return
  for (let offset = 0; offset < text.length; offset += MAX_CHUNK) {
    emit(session, { event: 'stdout', data: text.slice(offset, offset + MAX_CHUNK) })
  }
}

function finish(session: AgentSession, code: number | null): void {
  if (session.ended) return
  const stdoutTail = session.stdout.end()
  if (stdoutTail) emitStdout(session, stdoutTail)
  const stderrTail = session.stderr.end()
  if (stderrTail) session.stderrTail = (session.stderrTail + stderrTail).slice(-4000)
  session.ended = true
  sessions.delete(session.id)
  const message = session.spawnError || session.stderrTail || undefined
  emit(session, { event: 'exit', code, message })
}

function dropSession(session: AgentSession): void {
  if (session.ended) return
  const pid = session.pid
  if (typeof pid === 'number') killGroup(pid)
  else session.child?.kill('SIGKILL')
  finish(session, null)
}

function dropSender(sender: object): void {
  for (const session of [...sessions.values()]) {
    if (session.sender !== sender) continue
    dropSession(session)
  }
}

export function disposeAgentSender(sender: object): void {
  dropSender(sender)
}

export function disposeAllAgentProcesses(): void {
  for (const session of [...sessions.values()]) dropSession(session)
}

function bindDestroy(sender: ShellSender): void {
  if (destroyBound.has(sender)) return
  destroyBound.add(sender)
  sender.on('destroyed', () => dropSender(sender))
}

/** Register `agent:spawn`, `agent:write`, `agent:kill`, `agent:which`, and `agent:probe`. Every handler checks the sender. */
export function registerHostAgent(deps: HostAgentDeps): void {
  spawnProcess = deps.spawn ?? nodeSpawn
  resolveLoginPath = deps.loginPath ?? loginPathFor
  resolveWhichAgents = deps.whichAgents ?? detectFromLoginPath
  const handle = (channel: string, listener: (event: ShellIpcEvent, payload: unknown) => unknown) => {
    deps.handle(channel, (event, payload) => {
      return Promise.resolve().then(() => {
        assertTrustedSender(event, deps.getTrust())
        return listener(event, payload)
      })
    })
  }

  handle('agent:spawn', async (event, payload) => {
    const record = requestRecord(payload)
    const spec = acceptedArgs(record.command, record.args)
    const cwd = await checkCwd(record.cwd)
    if (sessions.size >= MAX_SESSIONS) throw new Error('too many agent processes')
    const id = randomBytes(16).toString('hex')
    const session: AgentSession = {
      id,
      sender: event.sender,
      child: null,
      pid: null,
      ended: false,
      stdout: new StringDecoder('utf8'),
      stderr: new StringDecoder('utf8'),
      stderrTail: '',
      spawnError: '',
    }
    sessions.set(id, session)
    bindDestroy(event.sender)
    const pathOverride = await resolveLoginPath(cwd).catch(() => undefined)
    if (session.ended) return id
    const env = environmentFor(pathOverride, spec.command)
    let child: ChildProcess
    try {
      const options: SpawnOptions = {
        cwd,
        env,
        shell: false,
        detached: process.platform !== 'win32',
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      }
      child = spawnProcess(spec.command, spec.args, options)
    } catch (error) {
      session.spawnError = error instanceof Error && error.message ? error.message : 'spawn failed'
      finish(session, null)
      throw error
    }
    session.child = child
    session.pid = typeof child.pid === 'number' ? child.pid : null
    child.stdout?.on('data', (chunk: Buffer) => {
      if (session.ended) return
      emitStdout(session, session.stdout.write(chunk))
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      if (session.ended) return
      const text = session.stderr.write(chunk)
      if (text) session.stderrTail = (session.stderrTail + text).slice(-4000)
    })
    child.on('error', (error: Error) => {
      session.spawnError = error.message || 'spawn failed'
      finish(session, null)
    })
    child.on('close', (code) => {
      finish(session, typeof code === 'number' ? code : null)
    })
    return id
  })

  handle('agent:write', async (event, payload) => {
    const record = requestRecord(payload)
    if (typeof record.id !== 'string' || record.id.length === 0 || typeof record.data !== 'string') {
      throw new Error('Rejected invalid agent request')
    }
    if (Buffer.byteLength(record.data) > MAX_WRITE_BYTES) throw new Error('Rejected agent write')
    const session = sessions.get(record.id)
    if (!session || session.ended) return
    if (session.sender !== event.sender) throw new Error('Rejected agent write')
    const stdin = session.child?.stdin
    if (!stdin || stdin.destroyed) return
    await new Promise<void>((resolve, reject) => {
      stdin.write(record.data as string, (error) => (error ? reject(error) : resolve()))
    })
  })

  handle('agent:kill', async (event, payload) => {
    const record = requestRecord(payload)
    if (typeof record.id !== 'string' || record.id.length === 0) throw new Error('Rejected invalid agent request')
    const session = sessions.get(record.id)
    if (!session || session.ended) return
    if (session.sender !== event.sender) throw new Error('Rejected agent kill')
    dropSession(session)
  })

  handle('agent:which', async () => resolveWhichAgents())

  handle('agent:probe', async (_event, payload) => {
    try {
      const record = requestRecord(payload)
      const mode = record.mode
      if (typeof record.command !== 'string' || typeof mode !== 'string' || !isExternalAgentMode(mode)) {
        return { found: false, resolved: '' }
      }
      return await probeExecutable(record.command, mode)
    } catch {
      return { found: false, resolved: '' }
    }
  })
}
