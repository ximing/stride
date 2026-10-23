import { beforeEach, describe, expect, it, vi } from 'vitest'
import { GitError } from '@stride/core/git'
import { ShellGitBackend } from './index.ts'

interface ShellCall {
  program: string
  args: string[]
  cwd?: string
  env?: Record<string, string>
}

interface ShellResult {
  code: number | null
  signal: number | null
  stdout: string
  stderr: string
}

const GIT_ENV = {
  GIT_MERGE_AUTOEDIT: 'no',
  GIT_TERMINAL_PROMPT: '0',
  LC_ALL: 'C',
}

const COMMIT_PREFIX = ['-c', 'user.name=Stride', '-c', 'user.email=stride@localhost', '-c', 'commit.gpgsign=false']

const shell = vi.hoisted(() => {
  const calls: ShellCall[] = []
  let handler: (call: ShellCall) => ShellResult = () => ({
    code: 0,
    signal: null,
    stdout: '',
    stderr: '',
  })
  return {
    calls,
    handle(next: (call: ShellCall) => ShellResult) {
      handler = next
    },
    reset() {
      calls.length = 0
      handler = () => ({ code: 0, signal: null, stdout: '', stderr: '' })
    },
    respond(call: ShellCall): ShellResult {
      calls.push(call)
      return handler(call)
    },
  }
})

vi.mock('@tauri-apps/plugin-shell', () => ({
  Command: {
    create(program: string, args: string | string[] = [], options?: { cwd?: string; env?: Record<string, string> }) {
      const argv = typeof args === 'string' ? [args] : [...args]
      return {
        async execute() {
          return shell.respond({ program, args: argv, cwd: options?.cwd, env: options?.env })
        },
      }
    },
  },
}))

function ok(stdout = '', stderr = ''): ShellResult {
  return { code: 0, signal: null, stdout, stderr }
}

function fail(code: number, stderr: string, stdout = ''): ShellResult {
  return { code, signal: null, stdout, stderr }
}

function argLines(): string[][] {
  return shell.calls.map((call) => call.args)
}

const git = new ShellGitBackend()

beforeEach(() => {
  shell.reset()
})

describe('ShellGitBackend', () => {
  it('inits main on the repo path', async () => {
    expect(git.available).toBe(true)
    await git.init('/Users/me/Notes')
    expect(shell.calls).toEqual([
      {
        program: 'git',
        args: ['init', '-b', 'main'],
        cwd: '/Users/me/Notes',
        env: GIT_ENV,
      },
    ])
  })

  it('parses clean and dirty porcelain', async () => {
    shell.handle((call) => {
      if (call.cwd === '/repo/clean') return ok('')
      return ok(' M note.md\n?? other.md\n')
    })
    await expect(git.status('/repo/clean')).resolves.toEqual({ repo: true, porcelain: '', clean: true })
    await expect(git.status('/repo/dirty')).resolves.toEqual({
      repo: true,
      porcelain: ' M note.md\n?? other.md\n',
      clean: false,
    })
    expect(argLines()).toEqual([
      ['status', '--porcelain'],
      ['status', '--porcelain'],
    ])
    expect(shell.calls.every((call) => call.program === 'git' && call.env?.GIT_TERMINAL_PROMPT === '0')).toBe(true)
  })

  it('falls back to the working tree diff when HEAD fails', async () => {
    shell.handle((call) => {
      if (call.args[1] === 'HEAD') return fail(128, 'fatal: bad revision HEAD\n')
      return ok('diff --git a/note.md b/note.md\n+edited\n')
    })
    await expect(git.diff('/repo', 'note.md')).resolves.toBe('diff --git a/note.md b/note.md\n+edited\n')
    expect(argLines()).toEqual([
      ['diff', 'HEAD', '--', 'note.md'],
      ['diff', '--', 'note.md'],
    ])
    expect(shell.calls.every((call) => call.cwd === '/repo')).toBe(true)
  })

  it('falls back when diff HEAD is empty', async () => {
    shell.handle((call) => (call.args[1] === 'HEAD' ? ok('  \n') : ok('unstaged\n')))
    await expect(git.diff('/repo')).resolves.toBe('unstaged\n')
    expect(argLines()).toEqual([
      ['diff', 'HEAD'],
      ['diff', '--'],
    ])
  })

  it('commits selected paths and the whole tree with the Stride identity', async () => {
    shell.handle((call) => (call.args.includes('commit') ? ok(' [main abc] Save note\n', 'warning: gpgsign skipped\n') : ok()))
    await expect(git.commit('/repo', 'Save note', ['note.md', 'other.md'])).resolves.toBe(
      '[main abc] Save note\nwarning: gpgsign skipped',
    )
    await expect(git.commit('/repo', 'Save note')).resolves.toBe('[main abc] Save note\nwarning: gpgsign skipped')
    expect(argLines()).toEqual([
      ['add', '--', 'note.md', 'other.md'],
      [...COMMIT_PREFIX, 'commit', '-m', 'Save note'],
      ['add', '-A'],
      [...COMMIT_PREFIX, 'commit', '-m', 'Save note'],
    ])
  })

  it('counts commits ahead of upstream and treats a missing upstream as zero', async () => {
    shell.handle((call) => {
      if (call.cwd === '/repo/local') return fail(128, "fatal: no upstream configured for branch 'main'\n")
      if (call.cwd === '/repo/missing') return fail(128, 'fatal: not a git repository\n')
      return ok('1\t0\n')
    })
    await expect(git.aheadBehind('/repo')).resolves.toEqual({ ahead: 1, behind: 0 })
    await expect(git.aheadBehind('/repo/local')).resolves.toEqual({ ahead: 0, behind: 0 })
    await expect(git.aheadBehind('/repo/missing')).rejects.toBeInstanceOf(GitError)
    expect(argLines()).toEqual([
      ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'],
      ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'],
      ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'],
    ])
  })

  it('parses history and treats a repo with no commits as empty', async () => {
    shell.handle((call) => {
      if (call.cwd === '/repo/empty') return fail(128, "fatal: your current branch 'main' does not have any commits yet\n")
      return ok('abc123\tAdd note\ndef456\tEdit note\n')
    })
    await expect(git.history('/repo', 'note.md')).resolves.toEqual([
      { hash: 'abc123', subject: 'Add note' },
      { hash: 'def456', subject: 'Edit note' },
    ])
    await expect(git.history('/repo/empty')).resolves.toEqual([])
    expect(argLines()).toEqual([
      ['log', '--format=%H%x09%s', '--', 'note.md'],
      ['log', '--format=%H%x09%s'],
    ])
  })

  it('shows one file at a revision without checkout', async () => {
    shell.handle(() => ok('previous note\n'))
    await expect(git.show('/repo', 'abc123', 'notes/a.stride.json')).resolves.toBe('previous note\n')
    expect(shell.calls.every((call) => call.program === 'git')).toBe(true)
    expect(argLines()).toEqual([['show', 'abc123:notes/a.stride.json']])
    expect(shell.calls.some((call) => call.args[0] === 'checkout' || call.args[0] === 'reset' || call.args[0] === 'clean' || call.args.includes('--force'))).toBe(false)
  })

  it('reads a remote url with git and treats a missing remote as null', async () => {
    shell.handle((call) => {
      if (call.cwd === '/repo/missing') return fail(2, "fatal: No such remote 'origin'\n")
      if (call.cwd === '/repo/broken') return fail(128, 'fatal: not a git repository\n')
      if (call.args[2] === 'upstream') return ok('https://example.com/upstream.git\n')
      return ok('https://example.com/origin.git\n')
    })
    await expect(git.remoteUrl('/repo')).resolves.toBe('https://example.com/origin.git')
    await expect(git.remoteUrl('/repo', 'upstream')).resolves.toBe('https://example.com/upstream.git')
    await expect(git.remoteUrl('/repo/missing')).resolves.toBeNull()
    await expect(git.remoteUrl('/repo/broken')).rejects.toBeInstanceOf(GitError)
    expect(shell.calls.every((call) => call.program === 'git')).toBe(true)
    expect(argLines()).toEqual([
      ['remote', 'get-url', 'origin'],
      ['remote', 'get-url', 'upstream'],
      ['remote', 'get-url', 'origin'],
      ['remote', 'get-url', 'origin'],
    ])
  })

  it('sets the url when the remote already exists', async () => {
    const url = 'https://example.com/origin.git'
    shell.handle((call) => {
      if (call.args[1] === 'add') return fail(3, 'error: remote origin already exists\n')
      return ok()
    })
    await git.addRemote('/repo', url)
    expect(argLines()).toEqual([
      ['remote', 'add', 'origin', url],
      ['remote', 'set-url', 'origin', url],
    ])
  })

  it('fetches a remote, compares FETCH_HEAD, and removes an unrelated remote', async () => {
    shell.handle((call) => {
      if (call.args[0] !== 'merge-base') return ok()
      if (call.cwd === '/repo/unrelated') return fail(1, '')
      if (call.cwd === '/repo/empty') return fail(128, 'fatal: Not a valid object name FETCH_HEAD\n')
      if (call.cwd === '/repo/broken') return fail(128, 'fatal: not a git repository\n')
      return ok('abc123\n')
    })
    await git.fetch('/repo')
    await expect(git.sharesHistory('/repo')).resolves.toBe(true)
    await git.fetch('/repo/unrelated', 'upstream')
    await expect(git.sharesHistory('/repo/unrelated')).resolves.toBe(false)
    await git.removeRemote('/repo/unrelated', 'upstream')
    await expect(git.sharesHistory('/repo/empty')).resolves.toBe(true)
    await expect(git.sharesHistory('/repo/broken')).rejects.toBeInstanceOf(GitError)
    expect(shell.calls.every((call) => call.program === 'git')).toBe(true)
    expect(argLines()).toEqual([
      ['fetch', 'origin'],
      ['merge-base', 'HEAD', 'FETCH_HEAD'],
      ['fetch', 'upstream'],
      ['merge-base', 'HEAD', 'FETCH_HEAD'],
      ['remote', 'remove', 'upstream'],
      ['merge-base', 'HEAD', 'FETCH_HEAD'],
      ['merge-base', 'HEAD', 'FETCH_HEAD'],
    ])
    expect(shell.calls.some((call) => call.args.includes('--force') || call.args[0] === 'reset' || call.args[0] === 'clean')).toBe(false)
  })

  it('pushes the current branch upstream', async () => {
    shell.handle((call) => {
      if (call.args[0] === 'rev-parse') return ok('main\n')
      return ok('', "branch 'main' set up to track 'origin/main'.\n")
    })
    await expect(git.push('/repo')).resolves.toBe("branch 'main' set up to track 'origin/main'.")
    expect(argLines()).toEqual([
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      ['push', '-u', 'origin', 'main'],
    ])
  })

  it('reports a clean pull and a conflicted pull', async () => {
    shell.handle((call) => {
      if (call.args[0] === 'rev-parse') return ok(call.cwd === '/repo/conflict' ? 'topic\n' : 'main\n')
      if (call.args.includes('pull') && call.cwd === '/repo/conflict') {
        return fail(1, 'CONFLICT (content): Merge conflict in note.md\nAutomatic merge failed; fix conflicts and then commit the result.\n')
      }
      if (call.args.includes('pull')) return ok('Already up to date.\n')
      if (call.cwd === '/repo/conflict') return ok('note.md\n')
      return ok('')
    })

    await expect(git.pull('/repo/clean')).resolves.toEqual({
      conflict: false,
      files: [],
      output: 'Already up to date.\n',
    })
    await expect(git.pull('/repo/conflict')).resolves.toEqual({
      conflict: true,
      files: ['note.md'],
      output: 'CONFLICT (content): Merge conflict in note.md\nAutomatic merge failed; fix conflicts and then commit the result.',
    })
    expect(argLines()).toEqual([
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      ['-c', 'pull.rebase=false', 'pull', 'origin', 'main'],
      ['diff', '--name-only', '--diff-filter=U'],
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      ['-c', 'pull.rebase=false', 'pull', 'origin', 'topic'],
      ['diff', '--name-only', '--diff-filter=U'],
    ])
  })

  it('rejects a non-conflict pull GitError', async () => {
    const stderr = "fatal: refusing to merge unrelated histories\n"
    shell.handle((call) => {
      if (call.args[0] === 'rev-parse') return ok('main\n')
      if (call.args.includes('pull')) return fail(128, stderr)
      return ok('')
    })
    try {
      await git.pull('/repo')
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(GitError)
      expect((error as GitError).code).toBe(128)
      expect((error as GitError).output).toBe(stderr.trim())
    }
    expect(argLines()).toEqual([
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      ['-c', 'pull.rebase=false', 'pull', 'origin', 'main'],
      ['diff', '--name-only', '--diff-filter=U'],
    ])
  })

  it('lists unmerged paths', async () => {
    shell.handle(() => ok('note.md\n\nother.md\n'))
    await expect(git.unmerged('/repo')).resolves.toEqual(['note.md', 'other.md'])
    expect(argLines()).toEqual([['diff', '--name-only', '--diff-filter=U']])
  })

  it('resolves ours and theirs, then commits when the tree is clean', async () => {
    shell.handle((call) => (call.args[0] === 'diff' ? ok('') : ok('resolved\n')))
    await git.resolve('/repo', 'note.md', 'ours')
    await git.resolve('/repo', 'other.md', 'theirs')
    expect(argLines()).toEqual([
      ['checkout', '--ours', '--', 'note.md'],
      ['add', '--', 'note.md'],
      ['diff', '--name-only', '--diff-filter=U'],
      [...COMMIT_PREFIX, 'commit', '-m', 'Resolve note.md keeping ours'],
      ['checkout', '--theirs', '--', 'other.md'],
      ['add', '--', 'other.md'],
      ['diff', '--name-only', '--diff-filter=U'],
      [...COMMIT_PREFIX, 'commit', '-m', 'Resolve other.md keeping theirs'],
    ])
  })

  it('clones into the destination from its parent directory', async () => {
    await git.clone('https://example.com/repo.git', '/vaults/other')
    expect(shell.calls).toEqual([
      {
        program: 'git',
        args: ['clone', 'https://example.com/repo.git', '/vaults/other'],
        cwd: '/vaults',
        env: GIT_ENV,
      },
    ])
  })

  it('rejects a non-zero exit with GitError and the stderr text', async () => {
    const stderr = 'fatal: not a git repository (or any of the parent directories): .git\n'
    shell.handle(() => fail(128, stderr))
    try {
      await git.status('/repo')
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(GitError)
      expect((error as GitError).code).toBe(128)
      expect((error as GitError).output).toBe(stderr.trim())
      expect((error as Error).message).toContain(stderr.trim())
    }
  })
})
