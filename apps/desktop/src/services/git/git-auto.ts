import { raw } from '@rabjs/react'
import {
  gitCommit,
  gitDiff,
  GitError,
  gitPull,
  gitPush,
  gitStatus,
  isNothingToCommit,
  unmergedFiles,
} from '@stride/core'
import type { GitBackend } from '@stride/platform'
import type { SettingsService } from '../settings/settings.service'
import type { VaultService } from '../vault/vault.service'
import type { GitService } from './git.service'

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export interface GitAutoDeps {
  vault: VaultService
  settings: SettingsService
  gitEnabled: () => boolean
  resolveGitBackend: () => Promise<GitBackend>
  checkpointMessage: (diff: string, signal: AbortSignal) => Promise<string | null>
}

interface AutoTimers {
  autoSyncTimer: ReturnType<typeof setInterval> | null
  autoSyncKick: ReturnType<typeof setTimeout> | null
  autoGitTimer: ReturnType<typeof setInterval> | null
  checkpointAbort: AbortController | null
}

// A failed push must not retry on the 1s auto-git clock. The interval is a separate backstop.
const PUBLISH_RETRY_MS = 30_000
// First sync should not wait out the whole interval after the vault opens.
const AUTO_SYNC_KICK_MS = 2_000

type CheckpointResult = 'stopped' | 'blocked' | 'backoff' | 'ready'
type PublishResult = 'ok' | 'conflict' | 'error' | 'stopped'

// Single-flight for git writes. `busy` stays a reentrant status count because
// `refresh` nests inside a write. Core `gitCommit` and `vault.flush` must not
// take this lock, or a tick that already holds it will skip its own commit.
const writeLocks = new WeakMap<object, boolean>()

export function tryBeginGitWrite(git: GitService): boolean {
  const key = raw(git)
  if (writeLocks.get(key)) return false
  writeLocks.set(key, true)
  git.busyCount += 1
  git.busy = true
  return true
}

export function endGitWrite(git: GitService) {
  writeLocks.set(raw(git), false)
  git.busyCount -= 1
  if (git.busyCount <= 0) {
    git.busyCount = 0
    git.busy = false
  }
}

export function resetGitWriteLock(git: GitService) {
  writeLocks.set(raw(git), false)
}

const timers = new WeakMap<object, AutoTimers>()

function autoTimers(host: object): AutoTimers {
  const key = raw(host)
  let slot = timers.get(key)
  if (!slot) {
    slot = { autoSyncTimer: null, autoSyncKick: null, autoGitTimer: null, checkpointAbort: null }
    timers.set(key, slot)
  }
  return slot
}

export function ensureAutoSync(git: GitService, deps: GitAutoDeps) {
  stopAutoSync(git)
  const minutes = deps.settings.form.autoSyncMinutes
  if (!(minutes > 0)) return
  const slot = autoTimers(git)
  slot.autoSyncKick = setTimeout(() => {
    slot.autoSyncKick = null
    void autoSyncTick(git, deps)
  }, AUTO_SYNC_KICK_MS)
  slot.autoSyncTimer = setInterval(() => {
    void autoSyncTick(git, deps)
  }, minutes * 60_000)
}

export function stopAutoSync(git: GitService) {
  const slot = autoTimers(git)
  if (slot.autoSyncKick !== null) {
    clearTimeout(slot.autoSyncKick)
    slot.autoSyncKick = null
  }
  if (slot.autoSyncTimer === null) return
  clearInterval(slot.autoSyncTimer)
  slot.autoSyncTimer = null
}

export function noteActivity(git: GitService) {
  git.lastActivityAt = Date.now()
}

export function noteBlur(git: GitService) {
  git.lastBlurAt = Date.now()
}

export function ensureAutoGit(git: GitService, deps: GitAutoDeps) {
  stopAutoGit(git)
  if (deps.settings.form.autoGitEnabled !== true) return
  const slot = autoTimers(git)
  slot.autoGitTimer = setInterval(() => {
    void autoGitTick(git, deps, Date.now())
  }, 1000)
}

export function stopAutoGit(git: GitService) {
  const slot = autoTimers(git)
  slot.checkpointAbort?.abort()
  slot.checkpointAbort = null
  if (slot.autoGitTimer === null) return
  clearInterval(slot.autoGitTimer)
  slot.autoGitTimer = null
}

function idleDue(git: GitService, idleSeconds: number, now: number): boolean {
  return idleSeconds > 0
    && git.lastActivityAt > 0
    && git.lastActivityAt !== git.idleCheckpointAt
    && now - git.lastActivityAt >= idleSeconds * 1000
}

function blurDue(git: GitService, blurSeconds: number, now: number): boolean {
  return blurSeconds > 0
    && git.lastBlurAt > 0
    && git.lastBlurAt !== git.blurCheckpointAt
    && now - git.lastBlurAt >= blurSeconds * 1000
}

// No keystrokes yet means the dirty files were already on disk. A recent edit waits for idle or blur.
function quietForCommit(git: GitService, now: number, idleSeconds: number, blurSeconds: number): boolean {
  return git.lastActivityAt === 0 || idleDue(git, idleSeconds, now) || blurDue(git, blurSeconds, now)
}

async function checkpointWorktree(
  git: GitService,
  deps: GitAutoDeps,
  backend: GitBackend,
  session: number,
  signal: AbortSignal,
): Promise<CheckpointResult> {
  const fs = deps.vault.fs
  if (!fs) return 'stopped'
  if (deps.vault.session !== session || signal.aborted) return 'stopped'
  if (!backend.available) return 'stopped'
  const unmerged = await unmergedFiles(fs, backend)
  if (deps.vault.session !== session || signal.aborted) return 'stopped'
  if (unmerged.length > 0) return 'blocked'
  try {
    await deps.vault.flush()
  } catch (error) {
    if (deps.vault.session !== session) return 'stopped'
    git.output = errorText(error)
    return 'stopped'
  }
  if (deps.vault.session !== session || signal.aborted) return 'stopped'
  let diff = ''
  try {
    diff = await gitDiff(fs, backend)
  } catch (error) {
    if (deps.vault.session !== session) return 'stopped'
    git.output = errorText(error)
    return 'stopped'
  }
  if (deps.vault.session !== session || signal.aborted) return 'stopped'
  let message: string | null
  try {
    message = await deps.checkpointMessage(diff, signal)
  } catch (error) {
    if (deps.vault.session !== session || signal.aborted) return 'stopped'
    git.output = errorText(error)
    return 'backoff'
  }
  // A partial or failed suggestion still backs off so the next second does not call the model.
  if (deps.vault.session !== session || signal.aborted) return 'stopped'
  if (message === null) return 'backoff'
  try {
    await gitCommit(fs, backend, message)
  } catch (error) {
    const output = error instanceof GitError ? error.output || error.message : errorText(error)
    if (!isNothingToCommit(output)) {
      if (deps.vault.session !== session) return 'stopped'
      git.output = output
      return 'backoff'
    }
  }
  if (deps.vault.session !== session || signal.aborted) return 'stopped'
  return 'ready'
}

// Auto Git skips pull/push without origin: a local-only vault should still checkpoint,
// and `git pull` without a remote is an error. The interval still pulls so an unset
// remote stays visible.
async function pullAndPush(
  git: GitService,
  deps: GitAutoDeps,
  backend: GitBackend,
  session: number,
  skipWithoutRemote: boolean,
): Promise<PublishResult> {
  const fs = deps.vault.fs
  if (!fs) return 'stopped'
  let remote: string | null = null
  try {
    remote = await backend.remoteUrl(fs.rootLabel, 'origin')
  } catch (error) {
    if (deps.vault.session !== session) return 'stopped'
    git.output = errorText(error)
    return 'error'
  }
  if (deps.vault.session !== session) return 'stopped'
  if (skipWithoutRemote && !remote) return 'ok'
  let result: Awaited<ReturnType<typeof gitPull>>
  try {
    result = await gitPull(fs, backend)
  } catch (error) {
    if (deps.vault.session !== session) return 'stopped'
    git.output = error instanceof GitError ? error.output || error.message : errorText(error)
    return 'error'
  }
  if (deps.vault.session !== session) return 'stopped'
  if (result.conflict) {
    git.conflicts = [...result.files]
    git.output = result.output
    await git.refresh()
    return deps.vault.session === session ? 'conflict' : 'stopped'
  }
  const pulled = !/already up to date/i.test(result.output)
  if (remote) {
    try {
      await gitPush(fs, backend)
    } catch (error) {
      if (deps.vault.session !== session) return 'stopped'
      git.output = error instanceof GitError ? error.output || error.message : errorText(error)
      if (pulled && deps.vault.session === session) await deps.vault.reopenForSettings()
      return deps.vault.session === session ? 'error' : 'stopped'
    }
    if (deps.vault.session !== session) return 'stopped'
  }
  git.conflicts = []
  git.output = ''
  if (pulled) {
    await deps.vault.reopenForSettings()
    if (deps.vault.session !== session) return 'stopped'
  }
  return 'ok'
}

export async function autoSyncTick(git: GitService, deps: GitAutoDeps) {
  const minutes = deps.settings.form.autoSyncMinutes
  if (!(minutes > 0)) return
  if (git.busy) return
  if (deps.vault.phase !== 'ready') return
  if (!deps.gitEnabled()) return
  if (git.surface !== 'ready') return
  if (!tryBeginGitWrite(git)) return
  const session = deps.vault.session
  const slot = autoTimers(git)
  const checkpointAbort = new AbortController()
  const previousAbort = slot.checkpointAbort
  slot.checkpointAbort = checkpointAbort
  try {
    const backend = await deps.resolveGitBackend()
    if (!backend.available) return
    const fs = deps.vault.fs
    if (!fs) return
    try {
      await deps.vault.flush()
    } catch (error) {
      git.output = error instanceof Error ? error.message : String(error)
      return
    }
    if (deps.vault.session !== session || checkpointAbort.signal.aborted) return
    const idleSeconds = deps.settings.form.autoGitIdleSeconds
    const blurSeconds = deps.settings.form.autoGitBlurSeconds
    if (deps.settings.form.autoGitEnabled === true && (idleSeconds > 0 || blurSeconds > 0)) {
      let clean = true
      let repo = true
      try {
        const status = await gitStatus(fs, backend)
        clean = status.clean
        repo = status.repo
      } catch (error) {
        if (deps.vault.session !== session) return
        git.output = errorText(error)
        return
      }
      if (deps.vault.session !== session || checkpointAbort.signal.aborted) return
      if (repo && !clean) {
        // Still typing: the idle checkpoint will commit. Don't surface a pull error every interval.
        if (!quietForCommit(git, Date.now(), idleSeconds, blurSeconds)) return
        const result = await checkpointWorktree(git, deps, backend, session, checkpointAbort.signal)
        if (result === 'blocked') {
          await git.refresh()
          return
        }
        if (result !== 'ready') return
      }
    }
    if (deps.vault.session !== session || checkpointAbort.signal.aborted) return
    const published = await pullAndPush(git, deps, backend, session, false)
    if (published === 'stopped' || published === 'conflict') return
    if (deps.vault.session !== session) return
    await git.refresh()
  } finally {
    if (slot.checkpointAbort === checkpointAbort) slot.checkpointAbort = previousAbort
    endGitWrite(git)
  }
}

export async function autoGitTick(git: GitService, deps: GitAutoDeps, now: number) {
  if (deps.settings.form.autoGitEnabled !== true) return
  const idleSeconds = deps.settings.form.autoGitIdleSeconds
  const blurSeconds = deps.settings.form.autoGitBlurSeconds
  const idleIsDue = idleDue(git, idleSeconds, now)
  const blurIsDue = blurDue(git, blurSeconds, now)
  const publishOnly = !idleIsDue && !blurIsDue
    && git.ahead > 0
    && (git.lastPublishAt === 0 || now - git.lastPublishAt >= PUBLISH_RETRY_MS)
  if (!idleIsDue && !blurIsDue && !publishOnly) return
  if (git.busy) return
  if (deps.vault.phase !== 'ready') return
  if (!deps.gitEnabled()) return
  if (git.surface !== 'ready') return
  if (!tryBeginGitWrite(git)) return
  const slot = autoTimers(git)
  const checkpointAbort = new AbortController()
  slot.checkpointAbort = checkpointAbort
  const session = deps.vault.session
  const rememberCheckpoint = () => {
    if (deps.vault.session !== session) return
    if (idleIsDue) git.idleCheckpointAt = git.lastActivityAt
    if (blurIsDue) git.blurCheckpointAt = git.lastBlurAt
  }
  try {
    const backend = await deps.resolveGitBackend()
    if (deps.vault.session !== session) return
    if (!backend.available) return
    const fs = deps.vault.fs
    if (!fs) return
    if (publishOnly) {
      git.lastPublishAt = now
      let clean = false
      try {
        clean = (await gitStatus(fs, backend)).clean
      } catch (error) {
        if (deps.vault.session !== session) return
        git.output = errorText(error)
        return
      }
      if (deps.vault.session !== session || checkpointAbort.signal.aborted || !clean) return
      const published = await pullAndPush(git, deps, backend, session, true)
      if (deps.vault.session !== session || published === 'stopped' || published === 'conflict') return
      await git.refresh()
      return
    }
    const result = await checkpointWorktree(git, deps, backend, session, checkpointAbort.signal)
    // stopAutoGit aborts the signal and leaves the stamp unset. A newer vault
    // must not see this tick's output, stamp, or refresh.
    if (result === 'stopped' || result === 'blocked') return
    if (result === 'backoff') {
      rememberCheckpoint()
      return
    }
    git.lastPublishAt = now
    const published = await pullAndPush(git, deps, backend, session, true)
    if (deps.vault.session !== session || published === 'conflict') return
    rememberCheckpoint()
    await git.refresh()
  } finally {
    if (slot.checkpointAbort === checkpointAbort) slot.checkpointAbort = null
    endGitWrite(git)
  }
}
