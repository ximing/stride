import { Service } from '@rabjs/react'
import {
  DEDICATED_ERROR,
  currentBranch,
  gitAddRemote,
  assertCloneDestEmpty,
  gitClone,
  gitCommit,
  gitDiff,
  GitError,
  gitPull,
  gitPush,
  gitResolveKeepingCheckpoint,
  gitShow,
  gitStatus,
  notePath,
  repoNameFromUrl,
  gitSurface,
  initGit,
  isDedicatedVault,
  isNothingToCommit,
  parsePorcelain,
  resolveLlm,
  suggestCommitMessage,
  type GitChange,
  type GitCommitInfo,
  type GitSurface,
  type LlmConfig,
} from '@stride/core'
import { browserGitBackend } from '@stride/git-web'
import { PlatformError, type FileSystemBackend, type GitBackend } from '@stride/platform'
import { isDesktopRuntime } from '../platform/runtime'
import { SettingsService } from '../settings/settings.service'
import { pickVaultBackend, VaultService } from '../vault/vault.service'
import * as gitAuto from './git-auto'
import type { GitAutoDeps } from './git-auto'

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const GIT_BROWSER = 'Git is not available in the browser'
const GIT_OFF = 'Git is turned off.'
const GIT_REMOTE_EMPTY = 'Enter a git repository URL'

/** Empty is allowed (leave the remote unchanged). Anything else must be a git remote URL. */
export function isGitRemoteUrl(value: string): boolean {
  const url = value.trim()
  if (url.length === 0) return true
  if (/^git@[^:\s]+:\S+$/.test(url)) return true
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:'
      || parsed.protocol === 'http:'
      || parsed.protocol === 'ssh:'
      || parsed.protocol === 'git:'
  } catch {
    return false
  }
}
const GIT_KEY_NOTICE = 'Add a model provider, base URL, model, and key in Settings'
const BROWSER_HOME = '/Users/stride'

let testGitBackend: GitBackend | null = null
let testGitBackendSet = false
let shellGitBackend: GitBackend | null = null
let cloneParentForTests: string | null = null
let cloneDestForTests: FileSystemBackend | null = null

type CommitMessageSuggest = (
  diff: string,
  signal: AbortSignal,
) => Promise<{ message: string; aborted: boolean }>

let commitMessageSuggestForTests: CommitMessageSuggest | null = null

export function setGitBackendForTests(backend: GitBackend | null) {
  if (backend === null) {
    testGitBackend = null
    testGitBackendSet = false
    return
  }
  testGitBackend = backend
  testGitBackendSet = true
}

export function setCloneParentForTests(path: string | null) {
  cloneParentForTests = path
}

export function setCloneDestForTests(fs: FileSystemBackend | null) {
  cloneDestForTests = fs
}

export function setCommitMessageSuggestForTests(next: CommitMessageSuggest | null) {
  commitMessageSuggestForTests = next
}

async function resolveGitBackend(): Promise<GitBackend> {
  if (testGitBackendSet && testGitBackend) return testGitBackend
  if (isDesktopRuntime()) {
    if (!shellGitBackend) {
      const { ShellGitBackend } = await import('@stride/git-tauri')
      shellGitBackend = new ShellGitBackend()
    }
    return shellGitBackend
  }
  return browserGitBackend()
}

export class GitService extends Service {
  status = ''
  diff = ''
  history = ''
  message = ''
  remote = ''
  private remoteRoot = ''
  private remoteNeedsLoad = true
  cloneUrl = ''
  cloneError = ''
  output = ''
  conflicts: string[] = []
  surface: GitSurface = 'needs-init'
  branch = ''
  notice = ''
  isRepo = false
  hasVault = false
  changes: GitChange[] = []
  selected: string[] = []
  ahead = 0
  behind = 0
  historyEntries: GitCommitInfo[] = []
  historyText = ''
  historyRev = ''
  private historyPath = ''
  suggesting = false
  busy = false
  busyCount = 0
  lastActivityAt = 0
  lastBlurAt = 0
  idleCheckpointAt = 0
  blurCheckpointAt = 0
  private diffPath = ''
  private suggestController: AbortController | null = null
  private suggestGeneration = 0

  constructor() {
    super()
    if (isDesktopRuntime()) return
    const preset = testGitBackendSet ? testGitBackend : browserGitBackend()
    if (preset && !preset.available) {
      this.output = GIT_BROWSER
      this.surface = 'unavailable'
    }
  }

  private get vault() {
    return this.resolve(VaultService)
  }

  private get settings() {
    return this.resolve(SettingsService)
  }

  setMessage(value: string) {
    this.message = value
  }

  setRemote(value: string) {
    this.remote = value
  }

  setCloneUrl(value: string) {
    this.cloneUrl = value
  }

  toggle(path: string) {
    if (this.selected.includes(path)) {
      this.selected = this.selected.filter((item) => item !== path)
      return
    }
    this.selected = [...this.selected, path]
  }

  private gitEnabled(): boolean {
    return this.settings.form.gitEnabled !== false
  }

  private clearWorktree() {
    this.branch = ''
    this.ahead = 0
    this.behind = 0
    this.changes = []
    this.selected = []
    this.diff = ''
    this.diffPath = ''
    this.conflicts = []
  }

  private applyChanges(next: GitChange[]) {
    const nextPaths = next.map((change) => change.path)
    const prevPaths = this.changes.map((change) => change.path)
    const same = prevPaths.length === nextPaths.length && nextPaths.every((path) => prevPaths.includes(path))
    if (same) {
      const live = new Set(nextPaths)
      this.selected = this.selected.filter((path) => live.has(path))
    } else {
      this.selected = [...nextPaths]
    }
    if (this.diffPath && !nextPaths.includes(this.diffPath)) {
      this.diff = ''
      this.diffPath = ''
    }
    this.changes = next
  }

  private async homeDirectory(): Promise<string> {
    if (!isDesktopRuntime()) return BROWSER_HOME
    try {
      const { homeDir } = await import('@tauri-apps/api/path')
      const home = await homeDir()
      if (!home) {
        this.output = 'Could not resolve the home directory'
        return ''
      }
      return home
    } catch (error) {
      this.output = error instanceof Error ? error.message : String(error)
      return ''
    }
  }

  private clearStaleBrowserBanner() {
    if (this.output === GIT_BROWSER) this.output = ''
  }

  async refresh() {
    this.busyCount += 1
    this.busy = true
    try {
      const backend = await resolveGitBackend()
      const fs = this.vault.fs
      if (!backend.available) {
        if (!fs) {
          this.hasVault = false
          this.isRepo = false
          this.surface = gitSurface({
            backendAvailable: false,
            gitEnabled: true,
            isRepo: false,
            broadBlocked: false,
          })
          this.clearWorktree()
          return
        }
        this.hasVault = true
        this.isRepo = Boolean(await fs.stat('.git'))
        this.surface = gitSurface({
          backendAvailable: false,
          gitEnabled: true,
          isRepo: this.isRepo,
          broadBlocked: false,
        })
        this.output = GIT_BROWSER
        this.clearWorktree()
        return
      }
      const gitEnabled = this.gitEnabled()
      if (!gitEnabled) {
        this.hasVault = Boolean(fs)
        this.isRepo = fs ? Boolean(await fs.stat('.git')) : false
        this.surface = 'disabled'
        this.clearWorktree()
        this.clearStaleBrowserBanner()
        return
      }
      if (!fs) {
        this.hasVault = false
        this.isRepo = false
        this.surface = gitSurface({ backendAvailable: true, gitEnabled, isRepo: false, broadBlocked: false })
        this.clearWorktree()
        this.clearStaleBrowserBanner()
        return
      }
      try {
        const status = await gitStatus(fs, backend)
        this.hasVault = true
        this.isRepo = status.repo
        const broadBlocked = this.vault.broad && !(await isDedicatedVault(fs))
        this.surface = gitSurface({
          backendAvailable: true,
          gitEnabled,
          isRepo: status.repo,
          broadBlocked,
        })
        this.clearStaleBrowserBanner()
        if (this.remoteRoot !== fs.rootLabel) {
          const switching = this.remoteRoot !== ''
          this.remoteRoot = fs.rootLabel
          if (switching) {
            this.remote = ''
            this.remoteNeedsLoad = true
          }
        }
        if (this.surface !== 'ready') {
          this.clearWorktree()
          return
        }
        if (this.remoteNeedsLoad) {
          if (this.remote !== '') {
            this.remoteNeedsLoad = false
          } else {
            try {
              this.remote = (await backend.remoteUrl(fs.rootLabel, 'origin')) ?? ''
              this.remoteNeedsLoad = false
            } catch (error) {
              this.remote = ''
              console.warn(`stride git remote: read-failed ${errorText(error)}`)
            }
          }
        }
        this.branch = await currentBranch(backend, fs.rootLabel)
        const counts = await backend.aheadBehind(fs.rootLabel)
        this.ahead = counts.ahead
        this.behind = counts.behind
        const next = parsePorcelain(status.porcelain)
        this.applyChanges(next)
        this.conflicts = next.filter((change) => change.unmerged).map((change) => change.path)
      } catch (error) {
        this.output = error instanceof Error ? error.message : String(error)
      }
    } finally {
      this.busyCount -= 1
      if (this.busyCount <= 0) {
        this.busyCount = 0
        this.busy = false
      }
    }
  }

  async openDiff(path: string) {
    const backend = await resolveGitBackend()
    if (!backend.available) {
      this.output = GIT_BROWSER
      return
    }
    if (!this.gitEnabled()) {
      this.output = GIT_OFF
      this.notice = GIT_OFF
      return
    }
    const fs = this.vault.fs
    if (!fs) return
    try {
      this.diff = await gitDiff(fs, backend, path)
      this.diffPath = path
      this.clearStaleBrowserBanner()
    } catch (error) {
      this.output = error instanceof Error ? error.message : String(error)
    }
  }

  async init() {
    const backend = await resolveGitBackend()
    if (!backend.available) {
      this.output = GIT_BROWSER
      this.surface = 'unavailable'
      return
    }
    if (!this.gitEnabled()) {
      this.notice = GIT_OFF
      this.output = GIT_OFF
      this.surface = 'disabled'
      return
    }
    const fs = this.vault.fs
    if (!fs) return
    const home = await this.homeDirectory()
    if (!home) return
    try {
      await initGit(fs, backend, home)
      const url = this.remote.trim()
      if (url) {
        await gitAddRemote(fs, backend, url)
        this.remote = url
        this.remoteNeedsLoad = false
      }
      await this.refresh()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.output = message
      this.notice = message
      if (message === DEDICATED_ERROR) this.surface = 'blocked'
    }
  }

  async commit() {
    this.busyCount += 1
    this.busy = true
    try {
      try {
        await this.vault.flush()
      } catch (error) {
        this.output = error instanceof Error ? error.message : String(error)
        return
      }
      const backend = await resolveGitBackend()
      if (!backend.available) this.output = GIT_BROWSER
    } finally {
      this.busyCount -= 1
      if (this.busyCount <= 0) {
        this.busyCount = 0
        this.busy = false
      }
    }
  }

  async commitSelected(paths?: readonly string[]) {
    this.busyCount += 1
    this.busy = true
    try {
      try {
        await this.vault.flush()
      } catch (error) {
        this.output = error instanceof Error ? error.message : String(error)
        return
      }
      const backend = await resolveGitBackend()
      if (!backend.available) {
        this.output = GIT_BROWSER
        return
      }
      if (!this.gitEnabled()) {
        this.notice = GIT_OFF
        this.output = GIT_OFF
        return
      }
      const fs = this.vault.fs
      if (!fs) return
      const chosen = [...(paths ?? this.selected)]
      try {
        await gitCommit(fs, backend, this.message, chosen)
        this.output = ''
        await this.refresh()
      } catch (error) {
        this.output = error instanceof Error ? error.message : String(error)
      }
    } finally {
      this.busyCount -= 1
      if (this.busyCount <= 0) {
        this.busyCount = 0
        this.busy = false
      }
    }
  }

  abortSuggest() {
    this.suggestGeneration += 1
    this.suggestController?.abort()
    this.suggestController = null
    this.suggesting = false
  }

  async suggestMessage() {
    this.abortSuggest()
    const generation = this.suggestGeneration
    const backend = await resolveGitBackend()
    if (generation !== this.suggestGeneration) return
    if (!backend.available) {
      this.output = GIT_BROWSER
      return
    }
    if (!this.gitEnabled()) {
      this.notice = GIT_OFF
      this.output = GIT_OFF
      return
    }
    const fs = this.vault.fs
    if (!fs) return
    const paths = [...this.selected]
    if (paths.length === 0) return
    const hooked = commitMessageSuggestForTests
    if (!hooked) {
      const runtime = this.settings.llmRuntime()
      if (!runtime?.apiKey || !runtime.model || !runtime.baseUrl) {
        this.notice = GIT_KEY_NOTICE
        return
      }
    }
    const controller = new AbortController()
    this.suggestController = controller
    this.suggesting = true
    try {
      const chunks: string[] = []
      for (const path of paths) {
        chunks.push(await gitDiff(fs, backend, path))
        if (generation !== this.suggestGeneration || controller.signal.aborted) return
      }
      const diff = chunks.join('')
      const result = hooked
        ? await hooked(diff, controller.signal)
        : await this.suggestWithLlm(diff, controller.signal)
      if (!result || generation !== this.suggestGeneration || controller.signal.aborted || result.aborted) return
      this.message = result.message
      this.notice = ''
    } catch (error) {
      if (generation !== this.suggestGeneration || controller.signal.aborted) return
      this.output = error instanceof Error ? error.message : String(error)
    } finally {
      if (generation === this.suggestGeneration) {
        this.suggesting = false
        this.suggestController = null
      }
    }
  }

  private async suggestWithLlm(
    diff: string,
    signal: AbortSignal,
  ): Promise<{ message: string; aborted: boolean } | null> {
    const runtime = this.settings.llmRuntime()
    if (!runtime?.apiKey || !runtime.model || !runtime.baseUrl) {
      this.notice = GIT_KEY_NOTICE
      return null
    }
    const config: LlmConfig = {
      id: 'active',
      name: runtime.provider,
      provider: runtime.provider,
      model: runtime.model,
      baseUrl: this.settings.devLlmBaseUrl(runtime.baseUrl),
      apiKey: runtime.apiKey,
      isDefault: true,
    }
    const resolved = resolveLlm(config)
    const suggested = await suggestCommitMessage({
      diff,
      model: resolved.model,
      apiKey: resolved.apiKey,
      signal,
      streamFn: (model, context, options) => resolved.models.streamSimple(model, context, {
        ...options,
        apiKey: resolved.apiKey,
      }),
    })
    if (suggested.usage) {
      this.settings.recordTokenUsage({
        model: runtime.model,
        input: suggested.usage.input,
        output: suggested.usage.output,
        cacheRead: suggested.usage.cacheRead,
        cacheWrite: suggested.usage.cacheWrite,
        total: suggested.usage.totalTokens,
      })
    }
    return { message: suggested.message, aborted: suggested.aborted }
  }

  async cloneRemote() {
    this.cloneError = ''
    const backend = await resolveGitBackend()
    if (!backend.available) {
      this.cloneError = 'git clone needs the desktop app'
      return
    }
    try {
      const url = this.cloneUrl
      const parent = cloneParentForTests !== null
        ? cloneParentForTests
        : (await pickVaultBackend()).rootLabel
      const dest = parent.replace(/\/$/, '') + '/' + repoNameFromUrl(url)
      const home = await this.homeDirectory()
      if (!home) {
        this.cloneError = this.output || 'Could not resolve the home directory'
        return
      }
      if (cloneDestForTests) {
        await assertCloneDestEmpty(cloneDestForTests)
      } else if (isDesktopRuntime()) {
        await this.assertTauriCloneDestEmpty(dest)
      }
      await gitClone(backend, url, dest, home)
      this.vault.openedClonePath = dest
      if (!isDesktopRuntime()) return
      const { TauriFileSystem } = await import('@stride/fs-tauri')
      await this.vault.openClonedVault(new TauriFileSystem(dest))
    } catch (error) {
      this.cloneError = error instanceof Error ? error.message : String(error)
    }
  }

  private autoGitDeps(): GitAutoDeps {
    return {
      vault: this.vault,
      settings: this.settings,
      gitEnabled: () => this.gitEnabled(),
      resolveGitBackend,
      checkpointMessage: (diff) => this.checkpointMessage(diff),
    }
  }

  ensureAutoSync() {
    gitAuto.ensureAutoSync(this, this.autoGitDeps())
  }

  stopAutoSync() {
    gitAuto.stopAutoSync(this)
  }

  noteActivity() {
    gitAuto.noteActivity(this)
  }

  noteBlur() {
    gitAuto.noteBlur(this)
  }

  ensureAutoGit() {
    gitAuto.ensureAutoGit(this, this.autoGitDeps())
  }

  stopAutoGit() {
    gitAuto.stopAutoGit(this)
  }

  async autoSyncTick() {
    return gitAuto.autoSyncTick(this, this.autoGitDeps())
  }

  async autoGitTick(now: number) {
    return gitAuto.autoGitTick(this, this.autoGitDeps(), now)
  }

  private async checkpointMessage(diff: string): Promise<string> {
    try {
      const signal = new AbortController().signal
      const hooked = commitMessageSuggestForTests
      let suggested = ''
      if (hooked) {
        const result = await hooked(diff, signal)
        suggested = result?.message ?? ''
      } else {
        const runtime = this.settings.llmRuntime()
        if (runtime?.apiKey && runtime.model && runtime.baseUrl) {
          const result = await this.suggestWithLlm(diff, signal)
          suggested = result?.message ?? ''
        }
      }
      return suggested.trim() || 'Checkpoint'
    } catch {
      return 'Checkpoint'
    }
  }

  private async assertTauriCloneDestEmpty(dest: string): Promise<void> {
    const { TauriFileSystem } = await import('@stride/fs-tauri')
    try {
      await assertCloneDestEmpty(new TauriFileSystem(dest))
    } catch (error) {
      // A missing folder is an empty clone destination.
      if (error instanceof PlatformError && error.code === 'not-found') return
      throw error
    }
  }

  async pull() {
    this.busyCount += 1
    this.busy = true
    try {
      try {
        await this.vault.flush()
      } catch (error) {
        this.output = error instanceof Error ? error.message : String(error)
        return
      }
      const backend = await resolveGitBackend()
      if (!backend.available) {
        this.output = GIT_BROWSER
        return
      }
      if (!this.gitEnabled()) {
        this.notice = GIT_OFF
        this.output = GIT_OFF
        return
      }
      const fs = this.vault.fs
      if (!fs) return
      try {
        const result = await gitPull(fs, backend)
        if (result.conflict) {
          this.conflicts = [...result.files]
          this.output = result.output
        } else {
          this.conflicts = []
          this.output = ''
        }
        await this.refresh()
      } catch (error) {
        this.output = error instanceof Error ? error.message : String(error)
      }
    } finally {
      this.busyCount -= 1
      if (this.busyCount <= 0) {
        this.busyCount = 0
        this.busy = false
      }
    }
  }

  async push() {
    this.busyCount += 1
    this.busy = true
    try {
      try {
        await this.vault.flush()
      } catch (error) {
        this.output = error instanceof Error ? error.message : String(error)
        return
      }
      const backend = await resolveGitBackend()
      if (!backend.available) {
        this.output = GIT_BROWSER
        return
      }
      if (!this.gitEnabled()) {
        this.notice = GIT_OFF
        this.output = GIT_OFF
        return
      }
      const fs = this.vault.fs
      if (!fs) return
      try {
        await gitPush(fs, backend)
        this.output = ''
        await this.refresh()
      } catch (error) {
        this.output = error instanceof Error ? error.message : String(error)
      }
    } finally {
      this.busyCount -= 1
      if (this.busyCount <= 0) {
        this.busyCount = 0
        this.busy = false
      }
    }
  }

  async addRemote() {
    this.busyCount += 1
    this.busy = true
    try {
      const backend = await resolveGitBackend()
      if (!backend.available) {
        this.output = GIT_BROWSER
        return
      }
      if (!this.gitEnabled()) {
        this.notice = GIT_OFF
        this.output = GIT_OFF
        return
      }
      const fs = this.vault.fs
      if (!fs) return
      const url = this.remote.trim()
      if (!url) {
        this.output = GIT_REMOTE_EMPTY
        return
      }
      try {
        if (!(await fs.stat('.git'))) {
          const home = await this.homeDirectory()
          if (!home) return
          await initGit(fs, backend, home)
        }
        await gitAddRemote(fs, backend, url)
        this.output = ''
        this.remote = url
        this.remoteNeedsLoad = false
        await this.refresh()
      } catch (error) {
        this.output = error instanceof Error ? error.message : String(error)
      }
    } finally {
      this.busyCount -= 1
      if (this.busyCount <= 0) {
        this.busyCount = 0
        this.busy = false
      }
    }
  }

  async loadHistory() {
    const backend = await resolveGitBackend()
    if (!backend.available) {
      this.output = GIT_BROWSER
      return
    }
    const fs = this.vault.fs
    const id = this.vault.activeId
    if (!fs || !id) return
    try {
      const path = notePath(id)
      this.historyPath = path
      this.historyEntries = await backend.history(fs.rootLabel, path)
      this.historyText = ''
      this.historyRev = ''
    } catch (error) {
      this.output = error instanceof Error ? error.message : String(error)
    }
  }

  async showHistory(rev: string) {
    const backend = await resolveGitBackend()
    if (!backend.available) {
      this.output = GIT_BROWSER
      return
    }
    const fs = this.vault.fs
    if (!fs || !this.historyPath) return
    try {
      this.historyText = await gitShow(fs, backend, rev, this.historyPath)
      this.historyRev = rev
      this.output = ''
    } catch (error) {
      this.output = error instanceof Error ? error.message : String(error)
    }
  }

  async restoreHistory() {
    const backend = await resolveGitBackend()
    if (!backend.available) {
      this.output = GIT_BROWSER
      return
    }
    const fs = this.vault.fs
    const id = this.vault.activeId
    if (!fs || !id || !this.historyPath || !this.historyRev) return
    if (this.historyPath !== notePath(id)) {
      this.output = 'Open the note whose history you are restoring'
      return
    }
    try {
      await this.vault.restoreActiveNote(this.historyText)
      this.output = ''
    } catch (error) {
      this.output = error instanceof Error ? error.message : String(error)
    }
  }

  async keepSide(path: string, side: 'ours' | 'theirs') {
    this.busyCount += 1
    this.busy = true
    try {
      const backend = await resolveGitBackend()
      if (!backend.available) {
        this.output = GIT_BROWSER
        return
      }
      const fs = this.vault.fs
      if (!fs) return
      try {
        await gitResolveKeepingCheckpoint(fs, backend, path, side)
        this.conflicts = await backend.unmerged(fs.rootLabel)
        this.output = ''
        await this.refresh()
        await this.vault.reopenForSettings()
      } catch (error) {
        this.output = error instanceof Error ? error.message : String(error)
      }
    } finally {
      this.busyCount -= 1
      if (this.busyCount <= 0) {
        this.busyCount = 0
        this.busy = false
      }
    }
  }
}
