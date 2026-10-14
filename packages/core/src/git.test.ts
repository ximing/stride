import { describe, expect, it } from 'vitest'
import { MemoryFileSystem, unavailableGit, type GitBackend } from '@stride/platform'
import { DEDICATED_ERROR, isBroadPersonalRoot } from './roots.ts'
import {
  assertCloneDestEmpty,
  gitAddRemote,
  gitClone,
  gitCommit,
  gitPull,
  gitResolve,
  gitStatus,
  initGit,
  repoNameFromUrl,
  isNoUpstream,
  mergeBaseSharesHistory,
  VAULT_GITIGNORE,
} from './git.ts'
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
    remoteUrl: () => Promise.resolve(null),
    addRemote: () => Promise.resolve(),
    fetch: () => Promise.resolve(),
    sharesHistory: () => Promise.resolve(true),
    removeRemote: () => Promise.resolve(),
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

describe('gitPull', () => {
  it('does not pull when git status is dirty', async () => {
    const files = new MemoryFileSystem('/tmp/dirty-pull')
    await files.mkdir('.git')
    const git = fakeGit()
    const pulls: string[] = []
    git.status = () => Promise.resolve({ repo: true, porcelain: ' M note.md\n', clean: false })
    git.pull = () => {
      pulls.push('pull')
      return Promise.resolve({ conflict: false, files: [], output: '' })
    }
    await expect(gitPull(files, git)).rejects.toThrow('Commit local changes before pulling')
    expect(pulls).toEqual([])
  })

  it('pulls when the working tree is clean', async () => {
    const files = new MemoryFileSystem('/tmp/clean-pull')
    await files.mkdir('.git')
    const git = fakeGit()
    const pulls: string[] = []
    git.pull = () => {
      pulls.push('pull')
      return Promise.resolve({ conflict: false, files: [], output: 'ok' })
    }
    await expect(gitPull(files, git)).resolves.toEqual({ conflict: false, files: [], output: 'ok' })
    expect(pulls).toEqual(['pull'])
  })

  it('does not pull when the folder is not a git repository', async () => {
    const files = new MemoryFileSystem('/tmp/not-a-repo')
    const git = fakeGit()
    const pulls: string[] = []
    git.pull = () => {
      pulls.push('pull')
      return Promise.resolve({ conflict: false, files: [], output: '' })
    }
    await expect(gitPull(files, git)).rejects.toThrow('Not a git repository')
    expect(pulls).toEqual([])
  })
})

describe('gitClone', () => {
  it('refuses the home directory and a Desktop basename without calling clone', async () => {
    const home = '/Users/someone'
    const git = fakeGit()
    const calls: string[] = []
    git.clone = (remote, dest) => {
      calls.push(`${remote} ${dest}`)
      return Promise.resolve()
    }
    await expect(gitClone(git, 'https://example.test/notes.git', home, home)).rejects.toThrow(DEDICATED_ERROR)
    await expect(gitClone(git, 'https://example.test/notes.git', `${home}/Desktop`, home)).rejects.toThrow(DEDICATED_ERROR)
    await expect(gitClone(git, 'https://example.test/notes.git', '/tmp/Documents', home)).rejects.toThrow(DEDICATED_ERROR)
    await expect(gitClone(git, 'https://example.test/notes.git', '/tmp/Downloads', home)).rejects.toThrow(DEDICATED_ERROR)
    expect(calls).toEqual([])
    await gitClone(git, '  https://example.test/notes.git  ', `${home}/notes`, home)
    expect(calls).toEqual(['https://example.test/notes.git /Users/someone/notes'])
  })

  it('does not clone an empty URL', async () => {
    const git = fakeGit()
    const calls: string[] = []
    git.clone = () => {
      calls.push('clone')
      return Promise.resolve()
    }
    await expect(gitClone(git, '', '/tmp/notes', '/Users/someone')).rejects.toThrow('Remote URL is empty')
    await expect(gitClone(git, '   ', '/tmp/notes', '/Users/someone')).rejects.toThrow('Remote URL is empty')
    expect(calls).toEqual([])
  })

  it('strips a trailing .git from the repository name', () => {
    expect(repoNameFromUrl('https://github.com/ximing/stride.git')).toBe('stride')
    expect(() => repoNameFromUrl('   ')).toThrow('Remote URL has no repository name')
    expect(() => repoNameFromUrl('https://example.test/..')).toThrow('Remote URL has no repository name')
    expect(() => repoNameFromUrl('https://example.test/.')).toThrow('Remote URL has no repository name')
  })

  it('rejects a non-empty destination and does not remove the file', async () => {
    const files = new MemoryFileSystem('/tmp/occupied')
    await files.writeText('keep.md', 'stay')
    await expect(assertCloneDestEmpty(files)).rejects.toThrow('Destination is not empty')
    expect(await files.readText('keep.md')).toBe('stay')
    await assertCloneDestEmpty(new MemoryFileSystem('/tmp/empty-dest'))
  })
})

describe('gitAddRemote', () => {
  it('keeps a related remote and removes an unrelated one before throwing', async () => {
    const files = new MemoryFileSystem('/tmp/remote-vault')
    const related = fakeGit()
    const relatedCalls: string[] = []
    related.addRemote = (_repo, url, name) => {
      relatedCalls.push(`add ${name ?? ''} ${url}`)
      return Promise.resolve()
    }
    related.fetch = (_repo, remote) => {
      relatedCalls.push(`fetch ${remote ?? ''}`)
      return Promise.resolve()
    }
    related.sharesHistory = () => {
      relatedCalls.push('shares')
      return Promise.resolve(true)
    }
    related.removeRemote = () => {
      relatedCalls.push('remove')
      return Promise.resolve()
    }
    await gitAddRemote(files, related, 'https://example.test/related.git')
    expect(relatedCalls).toEqual(['add origin https://example.test/related.git', 'fetch origin', 'shares'])

    const unrelated = fakeGit()
    const unrelatedCalls: string[] = []
    unrelated.addRemote = (_repo, url, name) => {
      unrelatedCalls.push(`add ${name ?? ''} ${url}`)
      return Promise.resolve()
    }
    unrelated.fetch = (_repo, remote) => {
      unrelatedCalls.push(`fetch ${remote ?? ''}`)
      return Promise.resolve()
    }
    unrelated.sharesHistory = () => {
      unrelatedCalls.push('shares')
      return Promise.resolve(false)
    }
    unrelated.removeRemote = (_repo, name) => {
      unrelatedCalls.push(`remove ${name ?? ''}`)
      return Promise.resolve()
    }
    await expect(gitAddRemote(files, unrelated, 'https://example.test/other.git', 'upstream')).rejects.toThrow(
      'Remote history is not compatible with this vault',
    )
    expect(unrelatedCalls).toEqual([
      'add upstream https://example.test/other.git',
      'fetch upstream',
      'shares',
      'remove upstream',
    ])
  })

  it('removes the remote when fetch fails and rethrows that error', async () => {
    const files = new MemoryFileSystem('/tmp/fetch-fail')
    const git = fakeGit()
    const calls: string[] = []
    git.addRemote = () => {
      calls.push('add')
      return Promise.resolve()
    }
    git.fetch = () => {
      calls.push('fetch')
      return Promise.reject(new Error('network down'))
    }
    git.removeRemote = () => {
      calls.push('remove')
      return Promise.reject(new Error('remove failed'))
    }
    await expect(gitAddRemote(files, git, 'https://example.test/x.git')).rejects.toThrow('network down')
    expect(calls).toEqual(['add', 'fetch', 'remove'])
  })

  it('restores the previous url when fetch fails and does not remove the remote', async () => {
    const files = new MemoryFileSystem('/tmp/fetch-restore')
    const git = fakeGit()
    const calls: string[] = []
    git.remoteUrl = () => Promise.resolve('https://example.test/old.git')
    git.addRemote = (_repo, url, name) => {
      calls.push(`add ${name ?? ''} ${url}`)
      return Promise.resolve()
    }
    git.fetch = () => {
      calls.push('fetch')
      return Promise.reject(new Error('network down'))
    }
    git.removeRemote = () => {
      calls.push('remove')
      return Promise.resolve()
    }
    await expect(gitAddRemote(files, git, 'https://example.test/new.git')).rejects.toThrow('network down')
    expect(calls).toEqual([
      'add origin https://example.test/new.git',
      'fetch',
      'add origin https://example.test/old.git',
    ])
  })

  it('restores the previous url when history is unrelated', async () => {
    const files = new MemoryFileSystem('/tmp/unrelated-restore')
    const git = fakeGit()
    const calls: string[] = []
    git.remoteUrl = () => Promise.resolve('https://example.test/old.git')
    git.addRemote = (_repo, url, name) => {
      calls.push(`add ${name ?? ''} ${url}`)
      return Promise.resolve()
    }
    git.fetch = () => {
      calls.push('fetch')
      return Promise.resolve()
    }
    git.sharesHistory = () => Promise.resolve(false)
    git.removeRemote = () => {
      calls.push('remove')
      return Promise.resolve()
    }
    await expect(gitAddRemote(files, git, 'https://example.test/other.git', 'upstream')).rejects.toThrow(
      'Remote history is not compatible with this vault',
    )
    expect(calls).toEqual([
      'add upstream https://example.test/other.git',
      'fetch',
      'add upstream https://example.test/old.git',
    ])
  })

  it('rethrows the original error when restoring the previous url fails', async () => {
    const files = new MemoryFileSystem('/tmp/restore-fails')
    const git = fakeGit()
    const calls: string[] = []
    git.remoteUrl = () => Promise.resolve('https://example.test/old.git')
    git.addRemote = (_repo, url) => {
      calls.push(url)
      if (url.endsWith('old.git')) return Promise.reject(new Error('set-url failed'))
      return Promise.resolve()
    }
    git.fetch = () => Promise.reject(new Error('network down'))
    git.removeRemote = () => {
      calls.push('remove')
      return Promise.resolve()
    }
    git.sharesHistory = () => Promise.reject(new Error('merge-base failed'))
    await expect(gitAddRemote(files, git, 'https://example.test/new.git')).rejects.toThrow('network down')
    expect(calls).toEqual(['https://example.test/new.git', 'https://example.test/old.git'])
  })
})

describe('mergeBaseSharesHistory', () => {
  it('treats a missing commit as shared history and exit 1 as unrelated', () => {
    expect(mergeBaseSharesHistory(128, 'fatal: Not a valid object name FETCH_HEAD')).toBe(true)
    expect(mergeBaseSharesHistory(128, "fatal: your current branch 'main' does not have any commits yet")).toBe(true)
    expect(mergeBaseSharesHistory(1, '')).toBe(false)
    expect(mergeBaseSharesHistory(128, 'fatal: no merge base')).toBe(false)
    expect(mergeBaseSharesHistory(128, 'fatal: not a git repository')).toBeNull()
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
