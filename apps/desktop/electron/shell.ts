import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { constants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import { delimiter, isAbsolute, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { assertTrustedSender, type RendererTrust } from './security.ts'

export interface ShellSender {
  getURL(): string
  send(channel: string, payload: unknown): void
  on(event: 'destroyed', listener: () => void): void
  isDestroyed(): boolean
}

export interface ShellIpcEvent {
  sender: ShellSender
}

export interface HostShellDeps {
  handle(channel: string, listener: (event: ShellIpcEvent, payload?: unknown) => unknown): void
  getTrust(): RendererTrust
  /** Test seam. Production uses `node:child_process` spawn. */
  spawn?: typeof nodeSpawn
}

type StopReason = 'exit' | 'cap' | 'timeout' | 'cancel'

interface ShellSession {
  id: string
  sender: ShellSender
  child: ChildProcess | null
  pid: number | null
  bytes: number
  reason: StopReason
  truncated: boolean
  ended: boolean
  stopping: boolean
  timer: ReturnType<typeof setTimeout> | null
  stdout: StringDecoder
  stderr: StringDecoder
  /** Login probe, separate from the user command so its output never reaches the renderer. */
  probe: ChildProcess | null
  killed: boolean
  /** One decoder flush for a normal close or a stop, so a partial UTF-8 tail is emitted once. */
  decodersFlushed: boolean
  /** Fires the probe close fallback when the probe process is killed. */
  probeRelease: (() => void) | null
  closeFallback: ReturnType<typeof setTimeout> | null
}

interface ProbeCache {
  interpreter: string
  path: string
}

const MAX_COMMAND_BYTES = 256 * 1024
const MAX_SESSIONS = 8
const MAX_OUTPUT_BYTES = 1024 * 1024
const MAX_EVENT_BYTES = 8 * 1024
const DEFAULT_PROBE_TIMEOUT_MS = 8000
const DEFAULT_KILL_CLOSE_FALLBACK_MS = 2000
/** Node clamps delays above this to 1ms. Keep the caller’s long timeout intact. */
const MAX_TIMER_MS = 2_147_483_647
const PROBE_CAPTURE_CHARS = 64 * 1024
const PATH_SENTINEL = '__STRIDE_PATH__'
const PROBE_SCRIPT = "printf '\\n__STRIDE_PATH__%s' \"$PATH\""
const UNIX_DIRS = ['/bin', '/usr/bin', '/usr/local/bin']

const sessions = new Map<string, ShellSession>()
const destroyBound = new WeakSet<ShellSender>()
let spawnProcess: typeof nodeSpawn = nodeSpawn
let probeCache: ProbeCache | null = null
let probeTimeoutMs = DEFAULT_PROBE_TIMEOUT_MS
let killCloseFallbackMs = DEFAULT_KILL_CLOSE_FALLBACK_MS

const REASON_RANK: Record<StopReason, number> = {
  exit: 0,
  cap: 1,
  timeout: 2,
  cancel: 3,
}

function requestRecord(payload: unknown): Record<string, unknown> {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error('Rejected invalid shell request')
  }
  return payload as Record<string, unknown>
}

function checkCommand(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Rejected invalid shell request')
  if (Buffer.byteLength(value) > MAX_COMMAND_BYTES) throw new Error('Command is too long')
  if (value.trim().length === 0) throw new Error('Command is empty')
  return value
}

async function checkCwd(value: unknown): Promise<string> {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || !isAbsolute(value)) {
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

function checkTimeout(value: unknown): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error('invalid timeout')
  if (value > MAX_TIMER_MS) return MAX_TIMER_MS
  return value
}

/**
 * Command env with one PATH key. Windows keeps `Path`; POSIX keeps `PATH`.
 * Every other spelling is dropped so a login override cannot lose to a leftover key.
 */
export function commandEnvironment(
  base: NodeJS.ProcessEnv,
  pathOverride: string | undefined,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const canonical = platform === 'win32' ? 'Path' : 'PATH'
  const env: NodeJS.ProcessEnv = {}
  let inherited: string | undefined
  let inheritedCanonical: string | undefined
  for (const [key, value] of Object.entries(base)) {
    if (key.toLowerCase() === 'path') {
      if (value === undefined) continue
      if (key === canonical) inheritedCanonical = value
      else if (inherited === undefined) inherited = value
      continue
    }
    env[key] = value
  }
  const pathValue = pathOverride !== undefined ? pathOverride : (inheritedCanonical ?? inherited)
  if (pathValue !== undefined) env[canonical] = pathValue
  return env
}

/** Test seam. Production stays at 8s probe / 2s kill-close fallback. */
export function setShellTestTimers(options?: { probeTimeoutMs?: number; killCloseFallbackMs?: number }): void {
  probeTimeoutMs = options?.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS
  killCloseFallbackMs = options?.killCloseFallbackMs ?? DEFAULT_KILL_CLOSE_FALLBACK_MS
}

function interpreterNames(): string[] {
  return process.platform === 'win32' ? ['bash.exe', 'zsh.exe', 'sh.exe'] : ['bash', 'zsh', 'sh']
}

function loginInterpreterNames(): string[] {
  return process.platform === 'win32' ? ['zsh.exe', 'bash.exe', 'sh.exe'] : ['zsh', 'bash', 'sh']
}

function searchDirs(): string[] {
  const dirs: string[] = []
  const seen = new Set<string>()
  const push = (dir: string) => {
    if (!dir || seen.has(dir)) return
    seen.add(dir)
    dirs.push(dir)
  }
  for (const dir of (process.env.PATH ?? '').split(delimiter)) push(dir)
  if (process.platform !== 'win32') {
    for (const dir of UNIX_DIRS) push(dir)
  }
  return dirs
}

async function isRunnable(path: string): Promise<boolean> {
  try {
    await access(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
    const info = await stat(path)
    return info.isFile()
  } catch {
    return false
  }
}

async function firstRunnable(names: string[]): Promise<string | null> {
  const dirs = searchDirs()
  for (const name of names) {
    for (const dir of dirs) {
      const path = join(dir, name)
      if (await isRunnable(path)) return path
    }
  }
  return null
}

async function loginInterpreters(): Promise<string[]> {
  const delay = Number(process.env.STRIDE_SHELL_LOOKUP_DELAY_MS ?? 0)
  if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
  const dirs = searchDirs()
  const found: string[] = []
  for (const name of loginInterpreterNames()) {
    for (const dir of dirs) {
      const path = join(dir, name)
      if (await isRunnable(path)) {
        found.push(path)
        break
      }
    }
  }
  return found
}

/** First runnable bash, then zsh, then sh. System PATH, then the fixed Unix bins. */
export async function resolveShellInterpreter(): Promise<string | null> {
  return firstRunnable(interpreterNames())
}

/** Drop the cached login PATH. Tests use this so a fake probe cannot leak into later cases. */
export function clearShellProbeCache(): void {
  probeCache = null
}

function appendProbeText(current: string, chunk: Buffer): string {
  const next = current + chunk.toString('utf8')
  if (next.length <= PROBE_CAPTURE_CHARS) return next
  return next.slice(next.length - PROBE_CAPTURE_CHARS)
}

function firstProbeLine(text: string): string {
  const crlf = text.indexOf('\r\n')
  const lf = text.indexOf('\n')
  if (crlf >= 0 && (lf < 0 || crlf <= lf)) return text.slice(0, crlf)
  if (lf >= 0) return text.slice(0, lf)
  return text
}

/** Last `__STRIDE_PATH__` line from a successful probe. Empty and non-zero exits are misses. */
export function readProbedPath(code: number | null, stdout: string, stderr: string): string | null {
  if (code !== 0) return null
  const text = `${stdout}\n${stderr}`
  const at = text.lastIndexOf(PATH_SENTINEL)
  if (at < 0) return null
  const line = firstProbeLine(text.slice(at + PATH_SENTINEL.length).trim()).trim()
  return line.length > 0 ? line : null
}

async function cachedLoginPath(): Promise<string | null> {
  if (!probeCache) return null
  if (!(await isRunnable(probeCache.interpreter))) {
    probeCache = null
    return null
  }
  return probeCache.path
}

function killSessionProcesses(session: ShellSession): void {
  if (session.killed) return
  session.killed = true
  const probePid = session.probe?.pid
  const userPid = session.pid
  if (typeof probePid === 'number') killGroup(probePid)
  if (typeof userPid === 'number' && userPid !== probePid) killGroup(userPid)
  session.probeRelease?.()
}

function runProbe(session: ShellSession, interpreter: string, cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    if (session.ended) {
      resolve(null)
      return
    }
    let child: ChildProcess
    try {
      child = spawnProcess(interpreter, ['-lic', PROBE_SCRIPT], {
        cwd,
        shell: false,
        detached: process.platform !== 'win32',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
      })
    } catch {
      resolve(null)
      return
    }
    session.probe = child
    let stdout = ''
    let stderr = ''
    let settled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let closeFallback: ReturnType<typeof setTimeout> | null = null
    const finishProbe = (value: string | null) => {
      if (settled) return
      settled = true
      if (timer !== null) clearTimeout(timer)
      if (closeFallback !== null) clearTimeout(closeFallback)
      if (session.probeRelease !== null) session.probeRelease = null
      if (session.probe === child) session.probe = null
      resolve(session.ended ? null : value)
    }
    const armProbeCloseFallback = () => {
      if (settled || closeFallback !== null) return
      closeFallback = setTimeout(() => finishProbe(null), killCloseFallbackMs)
    }
    session.probeRelease = () => {
      const pid = child.pid
      if (typeof pid === 'number') killGroup(pid)
      armProbeCloseFallback()
    }
    timer = setTimeout(() => {
      const pid = child.pid
      if (typeof pid === 'number') killGroup(pid)
      armProbeCloseFallback()
    }, probeTimeoutMs)
    if (session.ended) {
      const pid = child.pid
      if (typeof pid === 'number') killGroup(pid)
      finishProbe(null)
      return
    }
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = appendProbeText(stdout, chunk)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = appendProbeText(stderr, chunk)
    })
    child.on('error', () => finishProbe(null))
    child.on('close', (code) => {
      finishProbe(readProbedPath(typeof code === 'number' ? code : null, stdout, stderr))
    })
  })
}

async function resolveCommandPath(session: ShellSession, cwd: string): Promise<string | undefined> {
  const cached = await cachedLoginPath()
  if (cached) return cached
  if (session.ended) return undefined
  for (const interpreter of await loginInterpreters()) {
    if (session.ended) return undefined
    const found = await runProbe(session, interpreter, cwd)
    if (session.ended) return undefined
    if (!found) continue
    if (await isRunnable(interpreter)) {
      probeCache = { interpreter, path: found }
      return found
    }
    probeCache = null
  }
  return undefined
}

function note(session: ShellSession, reason: StopReason): void {
  if (REASON_RANK[reason] > REASON_RANK[session.reason]) session.reason = reason
}

function send(session: ShellSession, payload: Record<string, unknown>): void {
  if (session.sender.isDestroyed()) return
  try {
    session.sender.send('shell:event', payload)
  } catch {
    // Owner is gone. The destroyed listener kills the group.
  }
}

function emitText(session: ShellSession, event: 'stdout' | 'stderr', text: string): void {
  let rest = text
  while (rest.length > 0) {
    let end = rest.length
    if (Buffer.byteLength(rest) > MAX_EVENT_BYTES) {
      let bytes = 0
      end = 0
      for (const char of rest) {
        const size = Buffer.byteLength(char)
        if (bytes + size > MAX_EVENT_BYTES) break
        bytes += size
        end += char.length
      }
      if (end === 0) end = rest.length
    }
    const slice = rest.slice(0, end)
    rest = rest.slice(end)
    send(session, { id: session.id, event, data: slice })
    if (end === 0) break
  }
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
    // ESRCH means the group is already gone. The positive pid can still be alive.
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // Already gone.
    }
  }
}

function clearCloseFallback(session: ShellSession): void {
  if (session.closeFallback !== null) {
    clearTimeout(session.closeFallback)
    session.closeFallback = null
  }
}

function armCloseFallback(session: ShellSession): void {
  if (session.ended || session.closeFallback !== null) return
  session.closeFallback = setTimeout(() => {
    session.closeFallback = null
    if (session.ended) return
    flushDecoders(session)
    finish(session, 'exit', {
      code: null,
      truncated: session.truncated,
      reason: session.reason,
    })
  }, killCloseFallbackMs)
}

function stop(session: ShellSession, reason: StopReason): void {
  if (session.ended) {
    note(session, reason)
    return
  }
  note(session, reason)
  if (reason === 'cap') session.truncated = true
  killSessionProcesses(session)
  if (session.child === null) {
    session.stopping = true
    flushDecoders(session)
    finish(session, 'exit', {
      code: null,
      truncated: session.truncated,
      reason: session.reason,
    })
    return
  }
  if (session.stopping) return
  session.stopping = true
  flushDecoders(session)
  armCloseFallback(session)
}

function finish(session: ShellSession, event: 'exit' | 'error', extra: Record<string, unknown>): void {
  if (session.ended) return
  session.ended = true
  if (session.timer !== null) {
    clearTimeout(session.timer)
    session.timer = null
  }
  clearCloseFallback(session)
  sessions.delete(session.id)
  send(session, { id: session.id, event, ...extra })
}

function accept(session: ShellSession, decoder: StringDecoder, event: 'stdout' | 'stderr', chunk: Buffer): void {
  if (session.ended || session.stopping) return
  const room = MAX_OUTPUT_BYTES - session.bytes
  if (room <= 0) {
    stop(session, 'cap')
    return
  }
  let piece = chunk
  let capped = false
  if (chunk.length > room) {
    piece = chunk.subarray(0, room)
    capped = true
  }
  session.bytes += piece.length
  const text = decoder.write(piece)
  if (text) emitText(session, event, text)
  if (capped || session.bytes >= MAX_OUTPUT_BYTES) {
    const tail = decoder.end()
    if (tail) emitText(session, event, tail)
    stop(session, 'cap')
  }
}

function flushDecoders(session: ShellSession): void {
  if (session.decodersFlushed || session.ended) return
  session.decodersFlushed = true
  const stdoutTail = session.stdout.end()
  const stderrTail = session.stderr.end()
  if (stdoutTail) emitText(session, 'stdout', stdoutTail)
  if (stderrTail) emitText(session, 'stderr', stderrTail)
}

function dropSession(session: ShellSession): void {
  if (session.timer !== null) {
    clearTimeout(session.timer)
    session.timer = null
  }
  clearCloseFallback(session)
  const already = session.ended
  session.stopping = true
  session.ended = true
  sessions.delete(session.id)
  if (!already) killSessionProcesses(session)
}

function dropSender(sender: object): void {
  for (const session of [...sessions.values()]) {
    if (session.sender !== sender) continue
    dropSession(session)
  }
}

/** Stop sessions owned by this webContents. No terminal event: the old document is gone. */
export function disposeShellSender(sender: object): void {
  dropSender(sender)
}

/** Stop every shell session. Used from `app` `before-quit`. */
export function disposeAllShellSessions(): void {
  for (const session of [...sessions.values()]) dropSession(session)
}

function bindDestroy(sender: ShellSender): void {
  if (destroyBound.has(sender)) return
  destroyBound.add(sender)
  sender.on('destroyed', () => {
    dropSender(sender)
  })
}

function wire(session: ShellSession, child: ChildProcess, timeoutMs: number | undefined): void {
  session.child = child
  session.pid = typeof child.pid === 'number' ? child.pid : null
  if (session.ended || session.stopping) {
    if (session.pid !== null) killGroup(session.pid)
    if (!session.ended) {
      finish(session, 'exit', {
        code: null,
        truncated: session.truncated,
        reason: session.reason,
      })
    }
    return
  }
  child.stdout?.on('data', (chunk: Buffer) => accept(session, session.stdout, 'stdout', chunk))
  child.stderr?.on('data', (chunk: Buffer) => accept(session, session.stderr, 'stderr', chunk))
  child.on('error', (error: Error) => {
    finish(session, 'error', { message: error.message || 'shell session ended' })
  })
  child.on('close', (code) => {
    flushDecoders(session)
    finish(session, 'exit', {
      code: typeof code === 'number' ? code : null,
      truncated: session.truncated,
      reason: session.reason,
    })
  })
  if (timeoutMs !== undefined) {
    session.timer = setTimeout(() => stop(session, 'timeout'), timeoutMs)
  }
  if (session.pid === null) {
    finish(session, 'error', { message: 'shell session ended' })
  }
}

/** Register `shell:spawn` and `shell:cancel`. Every handler checks the sender first. */
export function registerHostShell(deps: HostShellDeps): void {
  spawnProcess = deps.spawn ?? nodeSpawn
  const handle = (channel: string, listener: (event: ShellIpcEvent, payload: unknown) => unknown) => {
    deps.handle(channel, (event, payload) => {
      return Promise.resolve().then(() => {
        assertTrustedSender(event, deps.getTrust())
        return listener(event, payload)
      })
    })
  }

  handle('shell:spawn', async (event, payload) => {
    const record = requestRecord(payload)
    const command = checkCommand(record.command)
    const cwd = await checkCwd(record.cwd)
    const timeoutMs = checkTimeout(record.timeoutMs)
    if (sessions.size >= MAX_SESSIONS) throw new Error('too many shell processes')
    const interpreter = await resolveShellInterpreter()
    if (!interpreter) throw new Error('No shell is available')
    if (sessions.size >= MAX_SESSIONS) throw new Error('too many shell processes')

    const id = randomBytes(16).toString('hex')
    const session: ShellSession = {
      id,
      sender: event.sender,
      child: null,
      pid: null,
      bytes: 0,
      reason: 'exit',
      truncated: false,
      ended: false,
      stopping: false,
      timer: null,
      stdout: new StringDecoder('utf8'),
      stderr: new StringDecoder('utf8'),
      probe: null,
      killed: false,
      decodersFlushed: false,
      probeRelease: null,
      closeFallback: null,
    }
    sessions.set(id, session)
    bindDestroy(event.sender)
    send(session, { id: session.id, event: 'started' })
    const pathOverride = await resolveCommandPath(session, cwd)
    if (session.ended || session.killed) return id
    const env = commandEnvironment(process.env, pathOverride)
    let child: ChildProcess
    try {
      child = spawnProcess(interpreter, ['-c', command], {
        cwd,
        shell: false,
        detached: process.platform !== 'win32',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
      })
    } catch (error) {
      const message = error instanceof Error && error.message ? error.message : 'shell session ended'
      finish(session, 'error', { message })
      throw error
    }
    wire(session, child, timeoutMs)
    return id
  })

  handle('shell:cancel', async (event, payload) => {
    const record = requestRecord(payload)
    if (typeof record.id !== 'string' || record.id.length === 0) throw new Error('Rejected invalid shell request')
    const session = sessions.get(record.id)
    if (!session || session.ended) return
    if (session.sender !== event.sender) throw new Error('Rejected shell cancel')
    stop(session, 'cancel')
  })
}
