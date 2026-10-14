import { PlatformError } from './error.ts'

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

export interface GitBackend {
  readonly available: boolean
  init(repo: string): Promise<void>
  status(repo: string): Promise<GitStatus>
  diff(repo: string, relPath?: string): Promise<string>
  commit(repo: string, message: string, paths?: string[]): Promise<string>
  history(repo: string, relPath?: string): Promise<GitCommitInfo[]>
  show(repo: string, rev: string, relPath: string): Promise<string>
  currentBranch(repo: string): Promise<string>
  aheadBehind(repo: string): Promise<{ ahead: number; behind: number }>
  remoteUrl(repo: string, name?: string): Promise<string | null>
  addRemote(repo: string, url: string, name?: string): Promise<void>
  fetch(repo: string, remote?: string): Promise<void>
  sharesHistory(repo: string): Promise<boolean>
  removeRemote(repo: string, name?: string): Promise<void>
  push(repo: string): Promise<string>
  pull(repo: string): Promise<PullResult>
  unmerged(repo: string): Promise<string[]>
  resolve(repo: string, relPath: string, side: 'ours' | 'theirs'): Promise<void>
  clone(remoteUrl: string, dest: string): Promise<void>
}

function unavailable<T>(): Promise<T> {
  return Promise.reject(new PlatformError('git-unavailable', 'Git is not available'))
}

export function unavailableGit(): GitBackend {
  const backend: GitBackend = {
    available: false,
    init: () => unavailable(),
    status: () => unavailable(),
    diff: () => unavailable(),
    commit: () => unavailable(),
    history: () => unavailable(),
    show: () => unavailable(),
    currentBranch: () => unavailable(),
    aheadBehind: () => unavailable(),
    remoteUrl: () => unavailable(),
    addRemote: () => unavailable(),
    fetch: () => unavailable(),
    sharesHistory: () => unavailable(),
    removeRemote: () => unavailable(),
    push: () => unavailable(),
    pull: () => unavailable(),
    unmerged: () => unavailable(),
    resolve: () => unavailable(),
    clone: () => unavailable(),
  }
  return backend
}
