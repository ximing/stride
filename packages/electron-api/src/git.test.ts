import { afterEach, describe, expect, expectTypeOf, it } from 'vitest'
import { ELECTRON_BRIDGE_KEY } from './index.ts'
import { execGit, type GitExecResult } from './git.ts'

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[ELECTRON_BRIDGE_KEY]
})

function install(invoke: (channel: string, args?: unknown) => unknown) {
  Object.defineProperty(globalThis, ELECTRON_BRIDGE_KEY, {
    value: { invoke, on: () => () => undefined },
    configurable: true,
    writable: true,
  })
}

describe('execGit', () => {
  it('invokes git:exec with cwd, args, and env and returns the raw result', async () => {
    const seen: unknown[] = []
    const result: GitExecResult = { code: 128, signal: null, stdout: 'partial\n', stderr: 'fatal\n' }
    install(async (channel, args) => {
      seen.push({ channel, args })
      return result
    })
    await expect(execGit('/repo', ['status', '--porcelain'], { GIT_TERMINAL_PROMPT: '0' })).resolves.toEqual(result)
    await expect(execGit('/repo', ['init', '-b', 'main'])).resolves.toEqual(result)
    expect(seen).toEqual([
      { channel: 'git:exec', args: { cwd: '/repo', args: ['status', '--porcelain'], env: { GIT_TERMINAL_PROMPT: '0' } } },
      { channel: 'git:exec', args: { cwd: '/repo', args: ['init', '-b', 'main'] } },
    ])
    expectTypeOf(execGit).returns.resolves.toEqualTypeOf<GitExecResult>()
  })

  it('rejects a result that drops output fields', async () => {
    install(async () => ({ code: 1 }))
    await expect(execGit('/repo', ['status'])).rejects.toThrow(/invalid git result/)
  })
})
