import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DEDICATED_ERROR, isBroadPersonalRoot } from './roots.ts'
import { isDedicatedVault } from './vault.ts'

export class GitError extends Error {
  code: number
  output: string
  constructor(code: number, output: string) {
    super(output || `git exited ${code}`)
    this.name = 'GitError'
    this.code = code
    this.output = output
  }
}

export interface GitStatus {
  repo: boolean
  porcelain: string
  clean: boolean
}

export interface GitCommitInfo {
  hash: string
  subject: string
}

export interface PullResult {
  conflict: boolean
  files: string[]
  output: string
}

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

export function assertCanInitGit(vaultPath: string, homeDir = os.homedir()): void {
  const resolved = path.resolve(vaultPath)
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error('Choose an existing vault folder before initializing Git')
  }
  if (isBroadPersonalRoot(resolved, homeDir) && !isDedicatedVault(resolved)) {
    throw new Error(DEDICATED_ERROR)
  }
}

export async function initGit(vaultPath: string, homeDir = os.homedir()): Promise<void> {
  assertCanInitGit(vaultPath, homeDir)
  const gitDir = path.join(path.resolve(vaultPath), '.git')
  if (fs.existsSync(gitDir)) return
  await runGit(vaultPath, ['init', '-b', 'main'])
}

export async function gitStatus(vaultPath: string): Promise<GitStatus> {
  if (!fs.existsSync(path.join(vaultPath, '.git'))) {
    return { repo: false, porcelain: '', clean: true }
  }
  const { stdout } = await runGit(vaultPath, ['status', '--porcelain'])
  return { repo: true, porcelain: stdout, clean: stdout.trim() === '' }
}

export async function gitDiff(vaultPath: string, relPath?: string): Promise<string> {
  const relative = relPath ? vaultRelative(vaultPath, relPath) : undefined
  const args = ['diff', '--']
  if (relative) args.push(relative)
  try {
    const head = await runGit(vaultPath, relative ? ['diff', 'HEAD', '--', relative] : ['diff', 'HEAD'])
    if (head.stdout.trim()) return head.stdout
  } catch {
    // No HEAD yet: fall through to the working tree diff.
  }
  const { stdout } = await runGit(vaultPath, args)
  return stdout
}

export async function gitCommit(vaultPath: string, message: string): Promise<string> {
  const trimmed = message.trim()
  if (!trimmed) throw new Error('Commit message is empty')
  await runGit(vaultPath, ['add', '-A'])
  const result = await runGit(vaultPath, [...COMMIT_ARGS, 'commit', '-m', trimmed])
  return `${result.stdout}${result.stderr}`.trim()
}

export async function gitHistory(vaultPath: string, relPath?: string): Promise<GitCommitInfo[]> {
  const relative = relPath ? vaultRelative(vaultPath, relPath) : undefined
  const args = ['log', '--format=%H%x09%s']
  if (relative) args.push('--', relative)
  try {
    const { stdout } = await runGit(vaultPath, args)
    return stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const tab = line.indexOf('\t')
        return { hash: line.slice(0, tab), subject: line.slice(tab + 1) }
      })
  } catch (error) {
    if (error instanceof GitError && /does not have any commits|unknown revision|bad default revision/.test(error.output)) {
      return []
    }
    throw error
  }
}

export async function currentBranch(vaultPath: string): Promise<string> {
  const { stdout } = await runGit(vaultPath, ['rev-parse', '--abbrev-ref', 'HEAD'])
  return stdout.trim()
}

export async function gitAddRemote(vaultPath: string, url: string, name = 'origin'): Promise<void> {
  try {
    await runGit(vaultPath, ['remote', 'add', name, url])
  } catch (error) {
    if (error instanceof GitError && error.output.includes('already exists')) {
      await runGit(vaultPath, ['remote', 'set-url', name, url])
      return
    }
    throw error
  }
}

export async function gitPush(vaultPath: string): Promise<string> {
  const branch = await currentBranch(vaultPath)
  const result = await runGit(vaultPath, ['push', '-u', 'origin', branch])
  return `${result.stdout}${result.stderr}`.trim()
}

export async function unmergedFiles(vaultPath: string): Promise<string[]> {
  try {
    const { stdout } = await runGit(vaultPath, ['diff', '--name-only', '--diff-filter=U'])
    return stdout.split('\n').map((line) => line.trim()).filter(Boolean)
  } catch (error) {
    if (error instanceof GitError) return []
    throw error
  }
}

export async function gitPull(vaultPath: string): Promise<PullResult> {
  const branch = await currentBranch(vaultPath)
  let output = ''
  try {
    const result = await runGit(vaultPath, ['-c', 'pull.rebase=false', 'pull', 'origin', branch])
    output = `${result.stdout}${result.stderr}`
  } catch (error) {
    if (!(error instanceof GitError)) throw error
    output = error.output
  }
  const files = await unmergedFiles(vaultPath)
  const conflict = files.length > 0 || /CONFLICT|Automatic merge failed/i.test(output)
  return { conflict, files, output }
}

export function vaultRelative(vaultPath: string, relPath: string): string {
  if (!relPath || relPath.includes('\0')) throw new Error('Path escapes the vault')
  const root = path.resolve(vaultPath)
  const full = path.resolve(root, relPath)
  const relative = path.relative(root, full)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Path escapes the vault')
  }
  return relative
}

export async function gitResolve(vaultPath: string, relPath: string, side: 'ours' | 'theirs'): Promise<void> {
  if (side !== 'ours' && side !== 'theirs') throw new Error('Choose ours or theirs')
  const relative = vaultRelative(vaultPath, relPath)
  await runGit(vaultPath, ['checkout', `--${side}`, '--', relative])
  await runGit(vaultPath, ['add', '--', relative])
  const still = await unmergedFiles(vaultPath)
  if (still.length === 0) {
    try {
      await runGit(vaultPath, [...COMMIT_ARGS, 'commit', '-m', `Resolve ${relPath} keeping ${side}`])
    } catch (error) {
      if (error instanceof GitError && /nothing to commit|No changes/.test(error.output)) return
      throw error
    }
  }
}

export async function gitInitBare(dir: string): Promise<void> {
  fs.mkdirSync(dir, { recursive: true })
  await runGit(dir, ['init', '--bare', '-b', 'main'])
}

export async function gitClone(remote: string, dest: string): Promise<void> {
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  await runGit(path.dirname(dest), ['clone', remote, dest])
}
