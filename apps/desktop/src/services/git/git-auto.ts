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
  checkpointMessage: (diff: string) => Promise<string>
}

interface AutoTimers {
  autoSyncTimer: ReturnType<typeof setInterval> | null
  autoGitTimer: ReturnType<typeof setInterval> | null
}

const timers = new WeakMap<object, AutoTimers>()

function autoTimers(host: object): AutoTimers {
  const key = raw(host)
  let slot = timers.get(key)
  if (!slot) {
    slot = { autoSyncTimer: null, autoGitTimer: null }
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
  const session = deps.vault.session
  const backend = await deps.resolveGitBackend()
  if (!backend.available) return
  const fs = deps.vault.fs
  if (!fs) return
  git.busyCount += 1
  git.busy = true
  try {
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
    git.busyCount -= 1
    if (git.busyCount <= 0) {
      git.busyCount = 0
      git.busy = false
    }
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
  const backend = await deps.resolveGitBackend()
  if (!backend.available) return
  const fs = deps.vault.fs
  if (!fs) return
  const unmerged = await unmergedFiles(fs, backend)
  if (unmerged.length > 0) return
  git.busyCount += 1
  git.busy = true
  try {
    try {
      await deps.vault.flush()
    } catch (error) {
      git.output = errorText(error)
      return
    }
    let diff = ''
    try {
      diff = await gitDiff(fs, backend)
    } catch (error) {
      git.output = errorText(error)
      return
    }
    const message = await deps.checkpointMessage(diff)
    try {
      await gitCommit(fs, backend, message)
    } catch (error) {
      const output = error instanceof GitError ? error.output || error.message : errorText(error)
      if (!isNothingToCommit(output)) {
        git.output = output
        return
      }
    }
    if (idleDue) git.idleCheckpointAt = git.lastActivityAt
    if (blurDue) git.blurCheckpointAt = git.lastBlurAt
    await git.refresh()
  } finally {
    git.busyCount -= 1
    if (git.busyCount <= 0) {
      git.busyCount = 0
      git.busy = false
    }
  }
}
