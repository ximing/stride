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
  // merge-base says "Not a valid object name" when HEAD or FETCH_HEAD has no commit.
  return /does not have any commits|unknown revision|bad default revision|Not a valid object name/.test(output)
}

// null means the failure is not a history answer and the caller should rethrow.
export function mergeBaseSharesHistory(code: number, output: string): boolean | null {
  if (isNoCommitHistory(output)) return true
  if (code === 1 || /no merge base/i.test(output)) return false
  return null
}

export function isNothingToCommit(output: string): boolean {
  return /nothing to commit|No changes/.test(output)
}

export function isNoUpstream(output: string): boolean {
  return output.includes('no upstream')
    || output.includes('@{upstream}')
    || output.includes('no such branch')
}

export { parseAheadBehind } from './git-ahead.ts'

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

export function isNoSuchRemote(output: string): boolean {
  return /no such remote/i.test(output)
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

export async function gitCommit(
  fs: FileSystemBackend,
  git: GitBackend,
  message: string,
  paths?: string[],
): Promise<string> {
  const trimmed = message.trim()
  if (!trimmed) throw new Error('Commit message is empty')
  if (paths && paths.length === 0) throw new Error('Choose files to commit')
  if (paths) {
    const normalized = paths.map((path) => vaultRelative(path))
    return git.commit(fs.rootLabel, trimmed, normalized)
  }
  return git.commit(fs.rootLabel, trimmed)
}

export async function gitShow(
  fs: FileSystemBackend,
  git: GitBackend,
  rev: string,
  relPath: string,
): Promise<string> {
  const relative = vaultRelative(relPath)
  const revision = rev.trim()
  if (!revision) throw new Error('Choose a revision')
  return git.show(fs.rootLabel, revision, relative)
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

async function restoreRemote(
  git: GitBackend,
  repo: string,
  name: string,
  previous: string | null,
): Promise<void> {
  try {
    if (previous === null) await git.removeRemote(repo, name)
    else await git.addRemote(repo, previous, name)
  } catch {
    // Restore is best-effort. The original error is the one to report.
  }
}

export async function gitAddRemote(
  fs: FileSystemBackend,
  git: GitBackend,
  url: string,
  name = 'origin',
): Promise<void> {
  const repo = fs.rootLabel
  const previous = await git.remoteUrl(repo, name)
  await git.addRemote(repo, url, name)
  try {
    await git.fetch(repo, name)
    if (!(await git.sharesHistory(repo))) {
      throw new Error('Remote history is not compatible with this vault')
    }
  } catch (error) {
    await restoreRemote(git, repo, name, previous)
    throw error
  }
}

export async function gitPush(fs: FileSystemBackend, git: GitBackend): Promise<string> {
  return git.push(fs.rootLabel)
}

export async function unmergedFiles(fs: FileSystemBackend, git: GitBackend): Promise<string[]> {
  return git.unmerged(fs.rootLabel)
}

export async function gitPull(fs: FileSystemBackend, git: GitBackend): Promise<PullResult> {
  const status = await gitStatus(fs, git)
  if (!status.clean) throw new Error('Commit local changes before pulling')
  if (!status.repo) throw new Error('Not a git repository')
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

const CONFLICT_CHECKPOINT_DIR = '.stride/conflict-checkpoints'

// Checkpoint before checkout: a commit is refused while the index is unmerged.
export async function gitResolveKeepingCheckpoint(
  fs: FileSystemBackend,
  git: GitBackend,
  relPath: string,
  side: 'ours' | 'theirs',
): Promise<void> {
  if (side !== 'ours' && side !== 'theirs') throw new Error('Choose ours or theirs')
  const relative = vaultRelative(relPath)
  await fs.mkdir(CONFLICT_CHECKPOINT_DIR)
  const text = await fs.readText(relative)
  const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
  const checkpoint = `${CONFLICT_CHECKPOINT_DIR}/${stamp}-${relative.replaceAll('/', '_')}.txt`
  await fs.writeText(checkpoint, text)
  await git.resolve(fs.rootLabel, relative, side)
  const still = await git.unmerged(fs.rootLabel)
  if (still.length > 0) return
  const entries = await fs.list(CONFLICT_CHECKPOINT_DIR)
  const paths = entries
    .filter((entry) => entry.kind === 'file')
    .map((entry) => `${CONFLICT_CHECKPOINT_DIR}/${entry.name}`)
  try {
    await gitCommit(fs, git, 'Checkpoint conflicted file contents', paths)
  } catch (error) {
    const output = error instanceof GitError
      ? error.output
      : error instanceof Error
        ? error.message
        : String(error)
    if (!isNothingToCommit(output)) throw error
  }
}

export function repoNameFromUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '')
  const slash = trimmed.lastIndexOf('/')
  const segment = (slash === -1 ? trimmed : trimmed.slice(slash + 1)).replace(/\.git$/, '')
  if (segment === '' || segment === '.' || segment === '..') {
    throw new Error('Remote URL has no repository name')
  }
  return segment
}

export async function assertCloneDestEmpty(fs: FileSystemBackend): Promise<void> {
  const entries = await fs.list('')
  if (entries.length > 0) throw new Error('Destination is not empty')
}

export async function gitClone(git: GitBackend, remote: string, dest: string, homeDir: string): Promise<void> {
  const url = remote.trim()
  if (url === '') throw new Error('Remote URL is empty')
  if (isBroadPersonalRoot(dest, homeDir)) throw new Error(DEDICATED_ERROR)
  await git.clone(url, dest)
}
