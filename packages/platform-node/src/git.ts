import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import {
  GitError,
  isExistingRemote,
  isNoCommitHistory,
  isNoSuchRemote,
  isNothingToCommit,
  isNoUpstream,
  mergeBaseSharesHistory,
  parseAheadBehind,
  parseGitHistory,
  parseGitStatus,
  parsePullResult,
} from '@stride/core/git'
import type { GitBackend, GitCommitInfo, GitStatus, PullResult } from '@stride/platform'

function runGit(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      {
        cwd,
        timeout: 20000,
        maxBuffer: 8 * 1024 * 1024,
        env: {
          ...process.env,
          GIT_MERGE_AUTOEDIT: 'no',
          GIT_TERMINAL_PROMPT: '0',
        },
      },
      (error, stdout, stderr) => {
        if (error) {
          const err = error as NodeJS.ErrnoException & { code?: number | string }
          if (typeof err.code === 'number') {
            reject(new GitError(err.code, `${stdout}${stderr}`.trim()))
            return
          }
          reject(error)
          return
        }
        resolve({ stdout: String(stdout), stderr: String(stderr) })
      },
    )
  })
}

const COMMIT_ARGS = ['-c', 'user.name=Stride', '-c', 'user.email=stride@localhost', '-c', 'commit.gpgsign=false']

export class NodeGitBackend implements GitBackend {
  readonly available = true

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

  async show(repo: string, rev: string, relPath: string): Promise<string> {
    const { stdout } = await runGit(repo, ['show', `${rev}:${relPath}`])
    return stdout
  }

  async currentBranch(repo: string): Promise<string> {
    const { stdout } = await runGit(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])
    return stdout.trim()
  }

  async aheadBehind(repo: string): Promise<{ ahead: number; behind: number }> {
    try {
      const { stdout } = await runGit(repo, ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'])
      return parseAheadBehind(stdout)
    } catch (error) {
      const output = error instanceof GitError
        ? error.output
        : error instanceof Error
          ? error.message
          : String(error)
      if (isNoUpstream(output)) return { ahead: 0, behind: 0 }
      throw error
    }
  }

  async remoteUrl(repo: string, name = 'origin'): Promise<string | null> {
    try {
      const { stdout } = await runGit(repo, ['remote', 'get-url', name])
      return stdout.trim()
    } catch (error) {
      if (error instanceof GitError && isNoSuchRemote(error.output)) return null
      throw error
    }
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

  async fetch(repo: string, remote = 'origin'): Promise<void> {
    await runGit(repo, ['fetch', remote])
  }

  async sharesHistory(repo: string): Promise<boolean> {
    try {
      await runGit(repo, ['merge-base', 'HEAD', 'FETCH_HEAD'])
      return true
    } catch (error) {
      if (!(error instanceof GitError)) throw error
      const shared = mergeBaseSharesHistory(error.code, error.output)
      if (shared === null) throw error
      return shared
    }
  }

  async removeRemote(repo: string, name = 'origin'): Promise<void> {
    await runGit(repo, ['remote', 'remove', name])
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
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    await runGit(path.dirname(dest), ['clone', remoteUrl, dest])
  }
}

export async function gitInitBare(dir: string): Promise<void> {
  fs.mkdirSync(dir, { recursive: true })
  await runGit(dir, ['init', '--bare', '-b', 'main'])
}
