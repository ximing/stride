import { Command } from '@tauri-apps/plugin-shell'
import {
  GitError,
  isExistingRemote,
  isNoCommitHistory,
  isNothingToCommit,
  parseGitHistory,
  parseGitStatus,
  parsePullResult,
} from '@stride/core/git'
import type { GitBackend, GitCommitInfo, GitStatus, PullResult } from '@stride/platform'

const COMMIT_ARGS = ['-c', 'user.name=Stride', '-c', 'user.email=stride@localhost', '-c', 'commit.gpgsign=false']

// Merged onto the inherited environment. Passing null would clear it, including PATH.
const GIT_ENV = {
  GIT_MERGE_AUTOEDIT: 'no',
  GIT_TERMINAL_PROMPT: '0',
}

interface GitOutput {
  stdout: string
  stderr: string
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function parentDirectory(target: string): string {
  const trimmed = target.replace(/[\\/]+$/, '')
  const slash = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  if (slash < 0) return '.'
  if (slash === 0) return trimmed[0] === '/' ? '/' : trimmed.slice(0, 1)
  const parent = trimmed.slice(0, slash)
  if (/^[A-Za-z]:$/.test(parent)) return `${parent}\\`
  return parent
}

async function runGit(cwd: string, args: string[]): Promise<GitOutput> {
  const output = await Command.create('git', args, { cwd, env: GIT_ENV }).execute()
  const stdout = text(output.stdout)
  const stderr = text(output.stderr)
  if (output.code === 0) return { stdout, stderr }
  const combined = `${stdout}${stderr}`.trim()
  if (typeof output.code === 'number') throw new GitError(output.code, combined)
  throw new Error(combined || 'git exited without a status code')
}

export class ShellGitBackend implements GitBackend {
  readonly available: true = true

  async init(repo: string): Promise<void> {
    await runGit(repo, ['init', '-b', 'main'])
  }

  async status(repo: string): Promise<GitStatus> {
    const { stdout } = await runGit(repo, ['status', '--porcelain'])
    return parseGitStatus(stdout)
  }

  async diff(repo: string, relPath?: string): Promise<string> {
    const args = ['diff', '--']
    if (relPath) args.push(relPath)
    try {
      const head = await runGit(repo, relPath ? ['diff', 'HEAD', '--', relPath] : ['diff', 'HEAD'])
      if (head.stdout.trim()) return head.stdout
    } catch {
      // No HEAD yet: fall through to the working tree diff.
    }
    const { stdout } = await runGit(repo, args)
    return stdout
  }

  async commit(repo: string, message: string, paths?: string[]): Promise<string> {
    if (paths && paths.length > 0) await runGit(repo, ['add', '--', ...paths])
    else await runGit(repo, ['add', '-A'])
    const result = await runGit(repo, [...COMMIT_ARGS, 'commit', '-m', message])
    return `${result.stdout}${result.stderr}`.trim()
  }

  async history(repo: string, relPath?: string): Promise<GitCommitInfo[]> {
    const args = ['log', '--format=%H%x09%s']
    if (relPath) args.push('--', relPath)
    try {
      const { stdout } = await runGit(repo, args)
      return parseGitHistory(stdout)
    } catch (error) {
      if (error instanceof GitError && isNoCommitHistory(error.output)) return []
      throw error
    }
  }

  async currentBranch(repo: string): Promise<string> {
    const { stdout } = await runGit(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])
    return stdout.trim()
  }

  async addRemote(repo: string, url: string, name = 'origin'): Promise<void> {
    try {
      await runGit(repo, ['remote', 'add', name, url])
    } catch (error) {
      if (error instanceof GitError && isExistingRemote(error.output)) {
        await runGit(repo, ['remote', 'set-url', name, url])
        return
      }
      throw error
    }
  }

  async push(repo: string): Promise<string> {
    const branch = await this.currentBranch(repo)
    const result = await runGit(repo, ['push', '-u', 'origin', branch])
    return `${result.stdout}${result.stderr}`.trim()
  }

  async pull(repo: string): Promise<PullResult> {
    const branch = await this.currentBranch(repo)
    let output = ''
    try {
      const result = await runGit(repo, ['-c', 'pull.rebase=false', 'pull', 'origin', branch])
      output = `${result.stdout}${result.stderr}`
    } catch (error) {
      if (!(error instanceof GitError)) throw error
      output = error.output
    }
    const files = await this.unmerged(repo)
    return parsePullResult(output, files)
  }

  async unmerged(repo: string): Promise<string[]> {
    try {
      const { stdout } = await runGit(repo, ['diff', '--name-only', '--diff-filter=U'])
      return stdout.split('\n').map((line) => line.trim()).filter(Boolean)
    } catch (error) {
      if (error instanceof GitError) return []
      throw error
    }
  }

  async resolve(repo: string, relPath: string, side: 'ours' | 'theirs'): Promise<void> {
    await runGit(repo, ['checkout', `--${side}`, '--', relPath])
    await runGit(repo, ['add', '--', relPath])
    const still = await this.unmerged(repo)
    if (still.length === 0) {
      try {
        await runGit(repo, [...COMMIT_ARGS, 'commit', '-m', `Resolve ${relPath} keeping ${side}`])
      } catch (error) {
        if (error instanceof GitError && isNothingToCommit(error.output)) return
        throw error
      }
    }
  }

  async clone(remoteUrl: string, dest: string): Promise<void> {
    await runGit(parentDirectory(dest), ['clone', remoteUrl, dest])
  }
}
