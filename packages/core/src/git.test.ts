import { describe, expect, it } from 'vitest'
import { MemoryFileSystem, unavailableGit, type GitBackend } from '@stride/platform'
import { DEDICATED_ERROR, isBroadPersonalRoot } from './roots.ts'
import { gitCommit, gitResolve, gitStatus, initGit } from './git.ts'
import { markDedicatedVault } from './vault.ts'

function fakeGit(): GitBackend & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    available: true,
    init: (repo) => {
      calls.push(`init ${repo}`)
      return Promise.resolve()
    },
    status: (repo) => {
      calls.push(`status ${repo}`)
      return Promise.resolve({ repo: true, porcelain: '', clean: true })
    },
    diff: () => Promise.resolve(''),
    commit: (_repo, message) => {
      calls.push(`commit ${message}`)
      return Promise.resolve(message)
    },
    history: () => Promise.resolve([]),
    currentBranch: () => Promise.resolve('main'),
    addRemote: () => Promise.resolve(),
    push: () => Promise.resolve(''),
    pull: () => Promise.resolve({ conflict: false, files: [], output: '' }),
    unmerged: () => Promise.resolve([]),
    resolve: () => {
      calls.push('resolve')
      return Promise.resolve()
    },
    clone: () => Promise.resolve(),
  }
}

describe('vault git policy', () => {
  it('refuses a broad personal root unless the vault is marked dedicated', async () => {
    const documents = new MemoryFileSystem('/tmp/Documents')
    const git = fakeGit()
    await expect(initGit(documents, git, '/Users/someone')).rejects.toThrow(DEDICATED_ERROR)
    expect(git.calls).toEqual([])
    expect(await documents.stat('.git')).toBeNull()
    expect(isBroadPersonalRoot('/Users/someone', '/Users/someone')).toBe(true)
    expect(isBroadPersonalRoot('/Users/someone/Desktop', '/Users/someone')).toBe(true)
    expect(isBroadPersonalRoot('/Users/someone/Projects', '/Users/someone')).toBe(false)

    const downloads = new MemoryFileSystem('/tmp/Downloads')
    await markDedicatedVault(downloads)
    await initGit(downloads, git, '/Users/someone')
    expect(git.calls).toEqual(['init /tmp/Downloads'])
  })

  it('does not init twice, rejects an empty message, and rejects a path escape', async () => {
    const files = new MemoryFileSystem('/tmp/dedicated-vault')
    const git = fakeGit()
    await initGit(files, git, '/Users/someone')
    await files.writeText('.git/HEAD', 'ref: refs/heads/main\n')
    await initGit(files, git, '/Users/someone')
    expect(git.calls).toEqual(['init /tmp/dedicated-vault'])
    await expect(gitCommit(files, git, '   ')).rejects.toThrow(/empty/)
    expect(git.calls).toEqual(['init /tmp/dedicated-vault'])
    await expect(gitResolve(files, git, '../outside', 'ours')).rejects.toThrow(/escapes the vault/)
    await gitResolve(files, git, 'status.stride.json', 'ours')
    expect(git.calls).toContain('resolve')
    const status = await gitStatus(new MemoryFileSystem('/tmp/empty-vault'), git)
    expect(status).toEqual({ repo: false, porcelain: '', clean: true })
  })

  it('propagates an unavailable git backend', async () => {
    const files = new MemoryFileSystem('/tmp/vault')
    await expect(initGit(files, unavailableGit(), '/Users/someone')).rejects.toThrow(/not available/i)
  })
})
