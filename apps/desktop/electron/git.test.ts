// @vitest-environment node
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  registerHostGit,
  type HostExecError,
  type HostExecFile,
  type HostGitEvent,
  type HostGitSender,
} from './git.ts'
import type { RendererTrust } from './security.ts'

const DEV = 'http://127.0.0.1:1421/'
const trust: RendererTrust = { packaged: false, devUrl: DEV }

function createSender(url = DEV): HostGitSender {
  return { getURL: () => url }
}

function eventFor(sender: HostGitSender): HostGitEvent {
  return { sender }
}

describe('host git exec', () => {
  let root = ''
  let handlers: Map<string, (event: HostGitEvent, payload?: unknown) => unknown>
  let sender = createSender()

  beforeEach(async () => {
    sender = createSender()
    root = await mkdtemp(join(tmpdir(), 'stride-e03a-'))
    handlers = new Map()
    registerHostGit({
      handle(channel, listener) {
        handlers.set(channel, listener)
      },
      getTrust: () => trust,
    })
  })

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true })
  })

  function call(payload?: unknown, current = sender) {
    const handler = handlers.get('git:exec')
    if (!handler) throw new Error('missing git:exec')
    return handler(eventFor(current), payload)
  }

  it('rejects an untrusted sender before inspecting the payload', async () => {
    const execFile = vi.fn<HostExecFile>()
    handlers = new Map()
    registerHostGit({
      handle(channel, listener) {
        handlers.set(channel, listener)
      },
      getTrust: () => trust,
      execFile,
    })
    await expect(call({ cwd: root, args: ['status'] }, { getURL: () => 'https://evil.example/' })).rejects.toThrow(
      /untrusted renderer/,
    )
    expect(execFile).not.toHaveBeenCalled()
  })

  it('rejects a relative path, a missing directory, a file, and a bad env', async () => {
    const execFile = vi.fn<HostExecFile>()
    handlers = new Map()
    registerHostGit({
      handle(channel, listener) {
        handlers.set(channel, listener)
      },
      getTrust: () => trust,
      execFile,
    })
    const file = join(root, 'note.txt')
    await writeFile(file, 'x')
    await expect(call({ cwd: 'relative', args: ['status'] })).rejects.toThrow(/Rejected path/)
    await expect(call({ cwd: join(root, 'missing'), args: ['status'] })).rejects.toThrow(/ENOENT|Rejected path/)
    await expect(call({ cwd: file, args: ['status'] })).rejects.toThrow(/Rejected path/)
    await expect(call({ cwd: root, args: 'status' })).rejects.toThrow(/Rejected invalid git request/)
    await expect(call({ cwd: root, args: [1] })).rejects.toThrow(/Rejected invalid git request/)
    await expect(call({ cwd: root, args: ['status'], env: { PATH: '/evil', 'not key': 'x' } })).rejects.toThrow(
      /Rejected invalid git request/,
    )
    await expect(call({ cwd: root, args: ['status'], env: null })).rejects.toThrow(/Rejected invalid git request/)
    expect(execFile).not.toHaveBeenCalled()
  })

  it('merges env onto process.env and keeps PATH', async () => {
    let seenEnv: NodeJS.ProcessEnv | undefined
    const execFile: HostExecFile = (_file, _args, options, callback) => {
      seenEnv = options.env
      callback(null, 'ok', '')
    }
    handlers = new Map()
    registerHostGit({
      handle(channel, listener) {
        handlers.set(channel, listener)
      },
      getTrust: () => trust,
      execFile,
    })
    await expect(call({
      cwd: root,
      args: ['status', '--porcelain'],
      env: { PATH: '/evil', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
    })).resolves.toEqual({ code: 0, signal: null, stdout: 'ok', stderr: '' })
    expect(seenEnv?.PATH).toBe(process.env.PATH)
    expect(seenEnv?.GIT_TERMINAL_PROMPT).toBe('0')
    expect(seenEnv?.LC_ALL).toBe('C')
    expect(seenEnv?.HOME).toBe(process.env.HOME)
  })

  it('returns a non-zero exit with stdout and stderr', async () => {
    const execFile: HostExecFile = (_file, _args, _options, callback) => {
      const error: HostExecError = new Error('Command failed')
      error.code = 128
      error.signal = null
      callback(error, 'partial\n', 'fatal: not a git repository\n')
    }
    handlers = new Map()
    registerHostGit({
      handle(channel, listener) {
        handlers.set(channel, listener)
      },
      getTrust: () => trust,
      execFile,
    })
    await expect(call({ cwd: root, args: ['status'] })).resolves.toEqual({
      code: 128,
      signal: null,
      stdout: 'partial\n',
      stderr: 'fatal: not a git repository\n',
    })
  })

  it('rejects a spawn failure', async () => {
    const execFile: HostExecFile = (_file, _args, _options, callback) => {
      const error: HostExecError = new Error('spawn git ENOENT')
      error.code = 'ENOENT'
      callback(error, '', '')
    }
    handlers = new Map()
    registerHostGit({
      handle(channel, listener) {
        handlers.set(channel, listener)
      },
      getTrust: () => trust,
      execFile,
    })
    await expect(call({ cwd: root, args: ['status'] })).rejects.toThrow(/ENOENT/)
  })

  it('inits, commits, and reports a non-zero status in a temp directory', async () => {
    const init = await call({ cwd: root, args: ['init', '-b', 'main'] })
    expect(init).toMatchObject({ code: 0, signal: null })
    await writeFile(join(root, 'note.txt'), 'hello\n')
    const add = await call({ cwd: root, args: ['add', '--', 'note.txt'] })
    expect(add).toMatchObject({ code: 0 })
    const commit = await call({
      cwd: root,
      args: ['-c', 'user.name=Stride', '-c', 'user.email=stride@localhost', '-c', 'commit.gpgsign=false', 'commit', '-m', 'Save note'],
    })
    expect(commit).toMatchObject({ code: 0 })
    expect(`${(commit as { stdout: string }).stdout}${(commit as { stderr: string }).stderr}`).toContain('Save note')
    const status = await call({ cwd: root, args: ['status', '--porcelain'] })
    expect(status).toEqual({ code: 0, signal: null, stdout: '', stderr: '' })

    const outside = await mkdtemp(join(tmpdir(), 'stride-e03a-plain-'))
    try {
      const failed = await call({ cwd: outside, args: ['status', '--porcelain'] }) as {
        code: number
        signal: string | null
        stdout: string
        stderr: string
      }
      expect(failed.code).not.toBe(0)
      expect(failed.stderr.length + failed.stdout.length).toBeGreaterThan(0)
      expect(`${failed.stdout}${failed.stderr}`).toMatch(/not a git repository|fatal/i)
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })
})
