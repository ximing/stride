import { execFile as nodeExecFile, type ExecFileException } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type { GitExecResult } from '@stride/electron-api'
import { assertTrustedSender, type RendererTrust } from './security.ts'

/** Narrow stand-in for `child_process.execFile`. Exit codes stay numeric; spawn failures use a string code. */
export interface HostExecError extends Error {
  code?: number | string | null
  signal?: string | null
}

export interface HostExecOptions {
  cwd: string
  env: NodeJS.ProcessEnv
  shell: false
  encoding: 'utf8'
  maxBuffer: number
  windowsHide: true
}

export type HostExecFile = (
  file: string,
  args: readonly string[],
  options: HostExecOptions,
  callback: (error: HostExecError | null, stdout: string, stderr: string) => void,
) => void

export interface HostGitSender {
  getURL(): string
}

export interface HostGitEvent {
  sender: HostGitSender
}

export interface HostGitDeps {
  handle(channel: string, listener: (event: HostGitEvent, payload?: unknown) => unknown): void
  getTrust(): RendererTrust
  execFile?: HostExecFile
  stat?: typeof stat
}

const MAX_ARGS = 128
const MAX_ARG_LENGTH = 8192
const MAX_ENV_ENTRIES = 32
const MAX_ENV_KEY_LENGTH = 64
const MAX_ENV_VALUE_LENGTH = 4096
const MAX_BUFFER = 10 * 1024 * 1024

function requestRecord(payload: unknown): Record<string, unknown> {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error('Rejected invalid git request')
  }
  return payload as Record<string, unknown>
}

function gitArgs(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_ARGS) throw new Error('Rejected invalid git request')
  const args: string[] = []
  for (const item of value) {
    if (typeof item !== 'string' || item.length > MAX_ARG_LENGTH || item.includes('\0')) {
      throw new Error('Rejected invalid git request')
    }
    args.push(item)
  }
  return args
}

function gitEnv(value: unknown): Record<string, string> {
  if (value === undefined) return {}
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Rejected invalid git request')
  }
  const entries = Object.entries(value)
  if (entries.length > MAX_ENV_ENTRIES) throw new Error('Rejected invalid git request')
  const env: Record<string, string> = {}
  for (const [key, item] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || key.length > MAX_ENV_KEY_LENGTH) {
      throw new Error('Rejected invalid git request')
    }
    if (typeof item !== 'string' || item.length > MAX_ENV_VALUE_LENGTH || item.includes('\0')) {
      throw new Error('Rejected invalid git request')
    }
    if (key === 'PATH' || key === 'Path') continue
    env[key] = item
  }
  return env
}

function childEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const [key, value] of Object.entries(extra)) env[key] = value
  if (process.env.PATH !== undefined) env.PATH = process.env.PATH
  return env
}

function textChunk(value: unknown): string {
  if (typeof value === 'string') return value
  if (value instanceof Uint8Array) return Buffer.from(value).toString('utf8')
  return ''
}

function hostCode(code: ExecFileException['code']): number | string | null | undefined {
  if (typeof code === 'number' || typeof code === 'string' || code === null || code === undefined) return code
  return undefined
}

function hostExecFile(
  file: string,
  args: readonly string[],
  options: HostExecOptions,
  callback: (error: HostExecError | null, stdout: string, stderr: string) => void,
): void {
  nodeExecFile(file, args, options, (error, stdout, stderr) => {
    if (!error) {
      callback(null, textChunk(stdout), textChunk(stderr))
      return
    }
    const wrapped: HostExecError = new Error(error.message)
    wrapped.code = hostCode(error.code)
    wrapped.signal = typeof error.signal === 'string' ? error.signal : null
    callback(wrapped, textChunk(stdout), textChunk(stderr))
  })
}

function execResult(error: HostExecError | null, stdout: string, stderr: string): GitExecResult {
  if (!error) return { code: 0, signal: null, stdout, stderr }
  const signal = typeof error.signal === 'string' ? error.signal : null
  if (typeof error.code === 'number') return { code: error.code, signal, stdout, stderr }
  throw error
}

async function existingDirectory(path: unknown, statPath: typeof stat): Promise<string> {
  if (typeof path !== 'string' || path.length === 0 || path.includes('\0') || !isAbsolute(path)) {
    throw new Error('Rejected path')
  }
  const info = await statPath(path)
  if (!info.isDirectory()) throw new Error('Rejected path')
  return path
}

function runGit(
  execFile: HostExecFile,
  cwd: string,
  args: string[],
  env: Record<string, string>,
): Promise<GitExecResult> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      {
        cwd,
        env: childEnv(env),
        shell: false,
        encoding: 'utf8',
        maxBuffer: MAX_BUFFER,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        try {
          resolve(execResult(error, stdout, stderr))
        } catch (caught) {
          reject(caught)
        }
      },
    )
  })
}

/** Register `git:exec`. The sender is checked before cwd, args, or env are used. */
export function registerHostGit(deps: HostGitDeps): void {
  const execFile = deps.execFile ?? hostExecFile
  const statPath = deps.stat ?? stat
  deps.handle('git:exec', (event, payload) => {
    return Promise.resolve().then(async () => {
      assertTrustedSender(event, deps.getTrust())
      const record = requestRecord(payload)
      const cwd = await existingDirectory(record.cwd, statPath)
      const args = gitArgs(record.args)
      const env = gitEnv(record.env)
      return runGit(execFile, cwd, args, env)
    })
  })
}
