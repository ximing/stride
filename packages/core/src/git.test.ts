import { describe, expect, it } from 'vitest'
import { MemoryFileSystem, unavailableGit, type GitBackend } from '@stride/platform'
import { DEDICATED_ERROR, isBroadPersonalRoot } from './roots.ts'
import { gitCommit, gitResolve, gitStatus, initGit, isNoUpstream, VAULT_GITIGNORE } from './git.ts'
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
    aheadBehind: () => Promise.resolve({ ahead: 0, behind: 0 }),
  }
}

describe('vault git policy', () => {
  it('refuses a broad personal root unless the vault is marked dedicated', async () => {
    const homeDir = '/Users/someone'
    const git = fakeGit()
    const refused = [
      new MemoryFileSystem(homeDir),
      new MemoryFileSystem(`${homeDir}/Desktop`),
      new MemoryFileSystem('/tmp/Documents'),
      new MemoryFileSystem('/tmp/Downloads'),
    ]
    for (const files of refused) {
      await expect(initGit(files, git, homeDir)).rejects.toThrow(DEDICATED_ERROR)
      expect(await files.stat('.git')).toBeNull()
    }
    expect(git.calls).toEqual([])
    expect(isBroadPersonalRoot(homeDir, homeDir)).toBe(true)
    expect(isBroadPersonalRoot(`${homeDir}/Desktop`, homeDir)).toBe(true)
    expect(isBroadPersonalRoot(`${homeDir}/Projects`, homeDir)).toBe(false)

    const downloads = new MemoryFileSystem('/tmp/Downloads')
    await markDedicatedVault(downloads)
    await initGit(downloads, git, homeDir)
    expect(git.calls).toEqual(['init /tmp/Downloads', 'commit Initial commit'])
  })

  it('writes a gitignore, records the initial commit, and does not init twice', async () => {
    const files = new MemoryFileSystem('/tmp/dedicated-vault')
    const git = fakeGit()
    await initGit(files, git, '/Users/someone')
    expect(await files.readText('.gitignore')).toBe(VAULT_GITIGNORE)
    await files.writeText('.git/HEAD', 'ref: refs/heads/main\n')
    await initGit(files, git, '/Users/someone')
    expect(git.calls).toEqual(['init /tmp/dedicated-vault', 'commit Initial commit'])
    await expect(gitCommit(files, git, '   ')).rejects.toThrow(/empty/)
    expect(git.calls).toEqual(['init /tmp/dedicated-vault', 'commit Initial commit'])
    await expect(gitResolve(files, git, '../outside', 'ours')).rejects.toThrow(/escapes the vault/)
    await gitResolve(files, git, 'status.stride.json', 'ours')
    expect(git.calls).toContain('resolve')
    const status = await gitStatus(new MemoryFileSystem('/tmp/empty-vault'), git)
    expect(status).toEqual({ repo: false, porcelain: '', clean: true })
  })

  it('swallows an empty initial commit and propagates any other commit error', async () => {
    const empty = new MemoryFileSystem('/tmp/empty-commit')
    const quiet = fakeGit()
    quiet.commit = () => Promise.reject(new Error('nothing to commit, working tree clean'))
    await initGit(empty, quiet, '/Users/someone')
    expect(await empty.readText('.gitignore')).toBe(VAULT_GITIGNORE)

    const broken = new MemoryFileSystem('/tmp/broken-commit')
    const failing = fakeGit()
    failing.commit = () => Promise.reject(new Error('index locked'))
    await expect(initGit(broken, failing, '/Users/someone')).rejects.toThrow(/index locked/)
  })

  it('commits normalized paths and skips git when the message, selection, or path is unusable', async () => {
    const files = new MemoryFileSystem('/tmp/dedicated-vault')
    const calls: Array<{ message: string; paths?: string[] }> = []
    const git = fakeGit()
    git.commit = (_repo, message, paths) => {
      calls.push({ message, paths })
      return Promise.resolve(message)
    }
    await expect(gitCommit(files, git, 'Save notes', ['./notes/a.md', 'notes/./b.md'])).resolves.toBe('Save notes')
    expect(calls).toEqual([{ message: 'Save notes', paths: ['notes/a.md', 'notes/b.md'] }])
    await expect(gitCommit(files, git, '   ', ['notes/a.md'])).rejects.toThrow(/empty/)
    await expect(gitCommit(files, git, 'Save notes', ['../outside'])).rejects.toThrow(/escapes the vault/)
    await expect(gitCommit(files, git, 'Save notes', [])).rejects.toThrow('Choose files to commit')
    expect(calls).toEqual([{ message: 'Save notes', paths: ['notes/a.md', 'notes/b.md'] }])
    await expect(gitCommit(files, git, 'Initial commit')).resolves.toBe('Initial commit')
    expect(calls[1]).toEqual({ message: 'Initial commit', paths: undefined })
  })

  it('propagates an unavailable git backend', async () => {
    const files = new MemoryFileSystem('/tmp/vault')
    await expect(initGit(files, unavailableGit(), '/Users/someone')).rejects.toThrow(/not available/i)
    expect(await files.stat('.git')).toBeNull()
    expect(await files.stat('.gitignore')).toBeNull()
  })
})

describe('isNoUpstream', () => {
  it('matches a missing upstream and ignores other git failures', () => {
    expect(isNoUpstream("fatal: no upstream configured for branch 'main'")).toBe(true)
    expect(isNoUpstream("fatal: ambiguous argument 'HEAD...@{upstream}': unknown revision")).toBe(true)
    expect(isNoUpstream("fatal: no such branch: 'main'")).toBe(true)
    expect(isNoUpstream('fatal: not a git repository')).toBe(false)
    expect(isNoUpstream('index locked')).toBe(false)
    expect(isNoUpstream('nothing to commit')).toBe(false)
  })
})
