import { raw } from '@rabjs/react'
import {
  gitCommit,
  gitDiff,
  GitError,
  gitPull,
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
  autoGitTimer: ReturnType<typeof setInterval> | null
  checkpointAbort: AbortController | null
}

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
    slot = { autoSyncTimer: null, autoGitTimer: null, checkpointAbort: null }
    timers.set(key, slot)
  }
  return slot
}

export function ensureAutoSync(git: GitService, deps: GitAutoDeps) {
  stopAutoSync(git)
  const minutes = deps.settings.form.autoSyncMinutes
  if (!(minutes > 0)) return
  const slot = autoTimers(git)
  slot.autoSyncTimer = setInterval(() => {
    void autoSyncTick(git, deps)
  }, minutes * 60_000)
}

export function stopAutoSync(git: GitService) {
  const slot = autoTimers(git)
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

export async function autoSyncTick(git: GitService, deps: GitAutoDeps) {
  const minutes = deps.settings.form.autoSyncMinutes
  if (!(minutes > 0)) return
  if (git.busy) return
  if (deps.vault.phase !== 'ready') return
  if (!deps.gitEnabled()) return
  if (git.surface !== 'ready') return
  if (!tryBeginGitWrite(git)) return
  const session = deps.vault.session
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
    if (deps.vault.session !== session) return
    let result: Awaited<ReturnType<typeof gitPull>>
    try {
      result = await gitPull(fs, backend)
    } catch (error) {
      git.output = error instanceof Error ? error.message : String(error)
      return
    }
    if (deps.vault.session !== session) return
    if (result.conflict) {
      git.conflicts = [...result.files]
      git.output = result.output
      await git.refresh()
      return
    }
    git.conflicts = []
    git.output = ''
    if (!/already up to date/i.test(result.output)) await deps.vault.reopenForSettings()
    await git.refresh()
  } finally {
    endGitWrite(git)
  }
}

export async function autoGitTick(git: GitService, deps: GitAutoDeps, now: number) {
  if (deps.settings.form.autoGitEnabled !== true) return
  const idleSeconds = deps.settings.form.autoGitIdleSeconds
  const blurSeconds = deps.settings.form.autoGitBlurSeconds
  const idleDue = idleSeconds > 0
    && git.lastActivityAt > 0
    && git.lastActivityAt !== git.idleCheckpointAt
    && now - git.lastActivityAt >= idleSeconds * 1000
  const blurDue = blurSeconds > 0
    && git.lastBlurAt > 0
    && git.lastBlurAt !== git.blurCheckpointAt
    && now - git.lastBlurAt >= blurSeconds * 1000
  if (!idleDue && !blurDue) return
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
    if (idleDue) git.idleCheckpointAt = git.lastActivityAt
    if (blurDue) git.blurCheckpointAt = git.lastBlurAt
  }
  try {
    const backend = await deps.resolveGitBackend()
    if (deps.vault.session !== session) return
    if (!backend.available) return
    const fs = deps.vault.fs
    if (!fs) return
    const unmerged = await unmergedFiles(fs, backend)
    if (deps.vault.session !== session) return
    if (unmerged.length > 0) return
    try {
      await deps.vault.flush()
    } catch (error) {
      if (deps.vault.session !== session) return
      git.output = errorText(error)
      return
    }
    if (deps.vault.session !== session) return
    let diff = ''
    try {
      diff = await gitDiff(fs, backend)
    } catch (error) {
      if (deps.vault.session !== session) return
      git.output = errorText(error)
      return
    }
    if (deps.vault.session !== session || checkpointAbort.signal.aborted) return
    let message: string | null
    try {
      message = await deps.checkpointMessage(diff, checkpointAbort.signal)
    } catch (error) {
      if (deps.vault.session !== session || checkpointAbort.signal.aborted) return
      git.output = errorText(error)
      rememberCheckpoint()
      return
    }
    // A newer vault must not see this tick's output, stamp, or refresh.
    // stopAutoGit aborts the signal and leaves the stamp unset. A partial or
    // failed suggestion still backs off so the next second does not call the model.
    if (deps.vault.session !== session || checkpointAbort.signal.aborted) return
    if (message === null) {
      rememberCheckpoint()
      return
    }
    try {
      await gitCommit(fs, backend, message)
    } catch (error) {
      const output = error instanceof GitError ? error.output || error.message : errorText(error)
      if (!isNothingToCommit(output)) {
        if (deps.vault.session !== session) return
        git.output = output
        rememberCheckpoint()
        return
      }
    }
    if (deps.vault.session !== session) return
    rememberCheckpoint()
    await git.refresh()
  } finally {
    if (slot.checkpointAbort === checkpointAbort) slot.checkpointAbort = null
    endGitWrite(git)
  }
}
