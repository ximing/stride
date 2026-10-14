import {
  normalizeRelativePath,
  type FileSystemBackend,
  type GitBackend,
  type GitCommitInfo,
  type GitStatus,
  type PullResult,
} from '@stride/platform'
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

export type { GitCommitInfo, GitStatus, PullResult }

export function parseGitStatus(stdout: string): GitStatus {
  return { repo: true, porcelain: stdout, clean: stdout.trim() === '' }
}

export function parseGitHistory(stdout: string): GitCommitInfo[] {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const tab = line.indexOf('\t')
      return { hash: line.slice(0, tab), subject: line.slice(tab + 1) }
    })
}

export function parsePullResult(output: string, files: string[]): PullResult {
  const conflict = files.length > 0 || /CONFLICT|Automatic merge failed/i.test(output)
  return { conflict, files, output }
}

export function isNoCommitHistory(output: string): boolean {
  return /does not have any commits|unknown revision|bad default revision/.test(output)
}

export function isNothingToCommit(output: string): boolean {
  return /nothing to commit|No changes/.test(output)
}

export const VAULT_GITIGNORE = `.DS_Store
Thumbs.db
.stride/rename-tx/
.stride/vane/
.stride/vane-dim
`

export { gitSurface } from './git-surface.ts'
export type { GitSurface } from './git-surface.ts'

export function isExistingRemote(output: string): boolean {
  return output.includes('already exists')
}

export function vaultRelative(relPath: string): string {
  if (!relPath || relPath.includes('\0')) throw new Error('Path escapes the vault')
  try {
    return normalizeRelativePath(relPath)
  } catch {
    throw new Error('Path escapes the vault')
  }
}

export async function assertCanInitGit(fs: FileSystemBackend, homeDir: string): Promise<void> {
  const stat = await fs.stat('')
  if (!stat || stat.kind !== 'directory') {
    throw new Error('Choose an existing vault folder before initializing Git')
  }
  if (isBroadPersonalRoot(fs.rootLabel, homeDir) && !(await isDedicatedVault(fs))) {
    throw new Error(DEDICATED_ERROR)
  }
}

export async function initGit(fs: FileSystemBackend, git: GitBackend, homeDir: string): Promise<void> {
  await assertCanInitGit(fs, homeDir)
  if (await fs.stat('.git')) return
  await git.init(fs.rootLabel)
  if (!(await fs.stat('.gitignore'))) await fs.writeText('.gitignore', VAULT_GITIGNORE)
  try {
    await git.commit(fs.rootLabel, 'Initial commit')
  } catch (error) {
    const output = error instanceof GitError
      ? error.output
      : error instanceof Error
        ? error.message
        : String(error)
    if (!isNothingToCommit(output)) throw error
  }
}

export async function gitStatus(fs: FileSystemBackend, git: GitBackend): Promise<GitStatus> {
  if (!(await fs.stat('.git'))) return { repo: false, porcelain: '', clean: true }
  return git.status(fs.rootLabel)
}

export async function gitDiff(fs: FileSystemBackend, git: GitBackend, relPath?: string): Promise<string> {
  const relative = relPath ? vaultRelative(relPath) : undefined
  return git.diff(fs.rootLabel, relative)
}

export async function gitCommit(fs: FileSystemBackend, git: GitBackend, message: string): Promise<string> {
  const trimmed = message.trim()
  if (!trimmed) throw new Error('Commit message is empty')
  return git.commit(fs.rootLabel, trimmed)
}

export async function gitHistory(
  fs: FileSystemBackend,
  git: GitBackend,
  relPath?: string,
): Promise<GitCommitInfo[]> {
  const relative = relPath ? vaultRelative(relPath) : undefined
  return git.history(fs.rootLabel, relative)
}

export async function currentBranch(git: GitBackend, repo: string): Promise<string> {
  return git.currentBranch(repo)
}

export async function gitAddRemote(
  fs: FileSystemBackend,
  git: GitBackend,
  url: string,
  name = 'origin',
): Promise<void> {
  await git.addRemote(fs.rootLabel, url, name)
}

export async function gitPush(fs: FileSystemBackend, git: GitBackend): Promise<string> {
  return git.push(fs.rootLabel)
}

export async function unmergedFiles(fs: FileSystemBackend, git: GitBackend): Promise<string[]> {
  return git.unmerged(fs.rootLabel)
}

export async function gitPull(fs: FileSystemBackend, git: GitBackend): Promise<PullResult> {
  return git.pull(fs.rootLabel)
}

export async function gitResolve(
  fs: FileSystemBackend,
  git: GitBackend,
  relPath: string,
  side: 'ours' | 'theirs',
): Promise<void> {
  if (side !== 'ours' && side !== 'theirs') throw new Error('Choose ours or theirs')
  const relative = vaultRelative(relPath)
  await git.resolve(fs.rootLabel, relative, side)
}

export async function gitClone(git: GitBackend, remote: string, dest: string): Promise<void> {
  await git.clone(remote, dest)
}
