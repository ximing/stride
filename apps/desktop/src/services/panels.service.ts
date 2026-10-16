import { has, Service } from '@rabjs/react'
import {
  EmbeddingClient,
  DEDICATED_ERROR,
  catalogDefaultModel,
  compareVersions,
  currentBranch,
  effectiveBaseUrl,
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
  llmProxyBaseUrl,
  maskSecret,
  parsePorcelain,
  readSettings,
  redactSecret,
  resolveLlm,
  suggestCommitMessage,
  testLlmConnection,
  toolsForAgentMode,
  unmergedFiles,
  vaultTools,
  writeSettings,
  type AppSettings,
  type GitChange,
  type GitCommitInfo,
  type GitSurface,
  type LlmConfig,
  type PublicLlmConfig,
  type UpdateChannel,
} from '@stride/core'
import { appendAssistantDelta, appendToolEnd, appendToolStart, playChatTurn, type ChatSession } from './chat-turn'
import { chatSystemPrompt, chatVaultHost } from './chat-vault-host'
import { browserGitBackend } from '@stride/git-web'
import { MemoryFileSystem, PlatformError, type FileSystemBackend, type GitBackend, type SecretsStore } from '@stride/platform'
import { webSecretsStore } from '../../../../packages/secrets-web/src/index.ts'
import { pickVaultBackend, VaultService } from './vault.service'

interface PublicSettings {
  embedding: { endpoint: string; model: string; keyMask: string; dim: number }
  llmConfigs: PublicLlmConfig[]
  releasesUrl: string
  gitEnabled: boolean
  autoSyncMinutes: number
  autoGitEnabled: boolean
  autoGitIdleSeconds: number
  autoGitBlurSeconds: number
  appearance: AppSettings['appearance']
  editor: AppSettings['editor']
  updates: AppSettings['updates']
  privacy: AppSettings['privacy']
}

const emptySettings = (): PublicSettings => ({
  embedding: { endpoint: '', model: '', keyMask: '', dim: 4 },
  llmConfigs: [],
  releasesUrl: '',
  gitEnabled: true,
  autoSyncMinutes: 0,
  autoGitEnabled: false,
  autoGitIdleSeconds: 0,
  autoGitBlurSeconds: 0,
  appearance: { noteWidth: 'standard', fontSize: 15 },
  editor: { autosaveDebounceMs: 350 },
  updates: { channel: 'stable', autoCheck: true },
  privacy: { telemetryEnabled: false },
})

const GIT_BROWSER = 'Git is not available in the browser'
const GIT_OFF = 'Git is turned off.'
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

function tauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

async function resolveGitBackend(): Promise<GitBackend> {
  if (testGitBackendSet && testGitBackend) return testGitBackend
  if (tauriRuntime()) {
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
  private busyCount = 0
  private autoSyncTimer: ReturnType<typeof setInterval> | null = null
  lastActivityAt = 0
  lastBlurAt = 0
  private idleCheckpointAt = 0
  private blurCheckpointAt = 0
  private autoGitTimer: ReturnType<typeof setInterval> | null = null
  private diffPath = ''
  private suggestController: AbortController | null = null
  private suggestGeneration = 0

  constructor() {
    super()
    if (tauriRuntime()) return
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
    if (!tauriRuntime()) return BROWSER_HOME
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
        if (this.surface !== 'ready') {
          this.clearWorktree()
          return
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
    return suggestCommitMessage({
      diff,
      model: resolved.model,
      apiKey: resolved.apiKey,
      signal,
      streamFn: (model, context, options) => resolved.models.streamSimple(model, context, {
        ...options,
        apiKey: resolved.apiKey,
      }),
    })
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
      } else if (tauriRuntime()) {
        await this.assertTauriCloneDestEmpty(dest)
      }
      await gitClone(backend, url, dest, home)
      this.vault.openedClonePath = dest
      if (!tauriRuntime()) return
      const { TauriFileSystem } = await import('@stride/fs-tauri')
      await this.vault.openClonedVault(new TauriFileSystem(dest))
    } catch (error) {
      this.cloneError = error instanceof Error ? error.message : String(error)
    }
  }

  ensureAutoSync() {
    this.stopAutoSync()
    const minutes = this.settings.form.autoSyncMinutes
    if (!(minutes > 0)) return
    this.autoSyncTimer = setInterval(() => {
      void this.autoSyncTick()
    }, minutes * 60_000)
  }

  stopAutoSync() {
    if (this.autoSyncTimer === null) return
    clearInterval(this.autoSyncTimer)
    this.autoSyncTimer = null
  }

  noteActivity() {
    this.lastActivityAt = Date.now()
  }

  noteBlur() {
    this.lastBlurAt = Date.now()
  }

  ensureAutoGit() {
    this.stopAutoGit()
    if (this.settings.form.autoGitEnabled !== true) return
    this.autoGitTimer = setInterval(() => {
      void this.autoGitTick(Date.now())
    }, 1000)
  }

  stopAutoGit() {
    if (this.autoGitTimer === null) return
    clearInterval(this.autoGitTimer)
    this.autoGitTimer = null
  }

  async autoSyncTick() {
    const minutes = this.settings.form.autoSyncMinutes
    if (!(minutes > 0)) return
    if (this.busy) return
    if (this.vault.phase !== 'ready') return
    if (!this.gitEnabled()) return
    if (this.surface !== 'ready') return
    const backend = await resolveGitBackend()
    if (!backend.available) return
    const fs = this.vault.fs
    if (!fs) return
    this.busyCount += 1
    this.busy = true
    try {
      try {
        await this.vault.flush()
      } catch (error) {
        this.output = error instanceof Error ? error.message : String(error)
        return
      }
      let result: Awaited<ReturnType<typeof gitPull>>
      try {
        result = await gitPull(fs, backend)
      } catch (error) {
        this.output = error instanceof Error ? error.message : String(error)
        return
      }
      if (result.conflict) {
        this.conflicts = [...result.files]
        this.output = result.output
        await this.refresh()
        return
      }
      this.conflicts = []
      this.output = ''
      if (!/already up to date/i.test(result.output)) await this.vault.reopenForSettings()
      await this.refresh()
    } finally {
      this.busyCount -= 1
      if (this.busyCount <= 0) {
        this.busyCount = 0
        this.busy = false
      }
    }
  }

  async autoGitTick(now: number) {
    if (this.settings.form.autoGitEnabled !== true) return
    const idleSeconds = this.settings.form.autoGitIdleSeconds
    const blurSeconds = this.settings.form.autoGitBlurSeconds
    const idleDue = idleSeconds > 0
      && this.lastActivityAt > 0
      && this.lastActivityAt !== this.idleCheckpointAt
      && now - this.lastActivityAt >= idleSeconds * 1000
    const blurDue = blurSeconds > 0
      && this.lastBlurAt > 0
      && this.lastBlurAt !== this.blurCheckpointAt
      && now - this.lastBlurAt >= blurSeconds * 1000
    if (!idleDue && !blurDue) return
    if (this.busy) return
    if (this.vault.phase !== 'ready') return
    if (!this.gitEnabled()) return
    if (this.surface !== 'ready') return
    const backend = await resolveGitBackend()
    if (!backend.available) return
    const fs = this.vault.fs
    if (!fs) return
    const unmerged = await unmergedFiles(fs, backend)
    if (unmerged.length > 0) return
    this.busyCount += 1
    this.busy = true
    try {
      try {
        await this.vault.flush()
      } catch (error) {
        this.output = errorText(error)
        return
      }
      let diff = ''
      try {
        diff = await gitDiff(fs, backend)
      } catch (error) {
        this.output = errorText(error)
        return
      }
      const message = await this.checkpointMessage(diff)
      try {
        await gitCommit(fs, backend, message)
      } catch (error) {
        const output = error instanceof GitError ? error.output || error.message : errorText(error)
        if (!isNothingToCommit(output)) {
          this.output = output
          return
        }
      }
      if (idleDue) this.idleCheckpointAt = this.lastActivityAt
      if (blurDue) this.blurCheckpointAt = this.lastBlurAt
      await this.refresh()
    } finally {
      this.busyCount -= 1
      if (this.busyCount <= 0) {
        this.busyCount = 0
        this.busy = false
      }
    }
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
      try {
        await gitAddRemote(fs, backend, this.remote.trim())
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

export class ChatService extends Service {
  draft = ''
  error = ''
  running = false
  sessions: ChatSession[] = [{ id: 'session-1', title: 'New', messages: [] }]
  activeId = 'session-1'
  private controller: AbortController | null = null
  private vaultToolSet: { id: string; tools: ReturnType<typeof vaultTools> } | null = null

  private get settings() {
    return this.resolve(SettingsService)
  }

  setDraft(value: string) {
    this.draft = value
  }

  select(id: string) {
    if (this.sessions.some((session) => session.id === id)) this.activeId = id
  }

  newSession() {
    const id = `session-${crypto.randomUUID()}`
    this.sessions.push({ id, title: 'New', messages: [] })
    this.activeId = id
  }

  abort() {
    this.controller?.abort()
  }

  private vaultTools() {
    const vault = this.resolve(VaultService)
    const id = `${vault.activeVaultId || 'none'}:${vault.agentMode}`
    if (!this.vaultToolSet || this.vaultToolSet.id !== id) {
      this.vaultToolSet = { id, tools: toolsForAgentMode(vaultTools(chatVaultHost(vault)), vault.agentMode) }
    }
    return this.vaultToolSet.tools
  }

  async send() {
    const text = this.draft.trim()
    if (!text || this.running) return
    const runtime = this.settings.llmRuntime()
    if (!runtime?.apiKey || !runtime.model || !runtime.baseUrl) {
      this.error = 'Add a model provider, base URL, model, and key in Settings'
      return
    }
    const session = this.sessions.find((item) => item.id === this.activeId)
    if (!session) return
    this.error = ''
    this.draft = ''
    if (session.title === 'New') session.title = text.slice(0, 32)
    session.messages.push({ role: 'user', text, thinking: '', tools: [] })
    session.messages.push({ role: 'assistant', text: '', thinking: '', tools: [] })
    const sessionId = session.id
    this.running = true
    const controller = new AbortController()
    this.controller = controller
    try {
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
      await playChatTurn({
        model: resolved.model,
        apiKey: resolved.apiKey,
        systemPrompt: chatSystemPrompt(this.resolve(VaultService)),
        prompt: text,
        tools: this.vaultTools(),
        signal: controller.signal,
        streamFn: (model, context, options) => resolved.models.streamSimple(model, context, {
          ...options,
          apiKey: resolved.apiKey,
        }),
        onText: (delta) => appendAssistantDelta(this.sessions, sessionId, 'text', delta),
        onThinking: (delta) => appendAssistantDelta(this.sessions, sessionId, 'thinking', delta),
        onToolStart: (call) => appendToolStart(this.sessions, sessionId, call),
        onToolEnd: (call) => appendToolEnd(this.sessions, sessionId, call),
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Agent failed'
      this.error = redactSecret(message, runtime.apiKey)
    } finally {
      this.running = false
      this.controller = null
    }
  }
}

export const SETTINGS_STORAGE_KEY = 'stride:settings'

const SETTINGS_FILE = 'settings.json'

export interface EmbeddingRuntime {
  endpoint: string
  model: string
  apiKey: string
  dim: number
  intended: boolean
  active: boolean
}

// What an index was actually opened with. Dim is 0 unless embedding is active.
export interface IndexSignature {
  endpoint: string
  model: string
  dim: number
  active: boolean
}

type SecretsSource = SecretsStore | (() => Promise<SecretsStore> | SecretsStore)

let secretsOverride: SecretsSource | null = null

export function setSecretsStore(next: SecretsSource | null) {
  secretsOverride = next
}

export function resetSecretsStore() {
  secretsOverride = null
}

function parsePositiveInt(value: string): number | null {
  const trimmed = value.trim()
  if (!/^[1-9]\d*$/.test(trimmed)) return null
  const parsed = Number(trimmed)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return null
  return parsed
}

// Empty clears the stored key. A mask-shaped draft keeps it. Anything else replaces it.
function resolveKey(draft: string, stored: string): string {
  if (draft === '') return ''
  if (draft.startsWith('••••')) return stored
  return draft
}

// An untouched LLM draft is missing and keeps the sealed key. Empty string clears it.
function resolveLlmKey(draft: string | undefined, stored: string): string {
  if (draft === undefined) return stored
  return resolveKey(draft, stored)
}

function keyForTest(draft: string, stored: string): string {
  if (draft === '' || draft.startsWith('••••')) return stored
  return draft
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function openedSignature(runtime: EmbeddingRuntime): IndexSignature {
  return {
    endpoint: runtime.endpoint,
    model: runtime.model,
    dim: runtime.active ? runtime.dim : 0,
    active: runtime.active,
  }
}

function sameIndexSignature(left: IndexSignature, right: IndexSignature): boolean {
  return left.endpoint === right.endpoint
    && left.model === right.model
    && left.dim === right.dim
    && left.active === right.active
}

async function settingsFile(): Promise<MemoryFileSystem> {
  const fs = new MemoryFileSystem('settings')
  if (typeof localStorage === 'undefined') return fs
  const raw = localStorage.getItem(SETTINGS_STORAGE_KEY)
  if (raw != null) await fs.writeText(SETTINGS_FILE, raw)
  return fs
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

export class SettingsService extends Service {
  form = emptySettings()
  embeddingKey = ''
  llmKeyDrafts: Record<string, string> = {}
  selectedLlmId = ''
  embeddingDimText = '4'
  embeddingTestResult = ''
  llmTestResult = ''
  notice = ''
  private memoryEmbeddingKey = ''
  private memoryLlmKeys: Record<string, string> = {}
  private loadTask: Promise<void> | null = null
  private loaded = false

  patchEmbedding(partial: Partial<PublicSettings['embedding']>) {
    this.form = { ...this.form, embedding: { ...this.form.embedding, ...partial } }
  }

  addLlmConfig() {
    const id = crypto.randomUUID()
    const config: PublicLlmConfig = {
      id,
      name: 'OpenAI',
      provider: 'openai',
      model: catalogDefaultModel('openai') || 'gpt-4o-mini',
      baseUrl: '',
      keyMask: '',
      isDefault: this.form.llmConfigs.length === 0,
    }
    this.form = { ...this.form, llmConfigs: [...this.form.llmConfigs, config] }
    this.selectedLlmId = id
  }

  removeLlmConfig(id = this.selectedLlmId) {
    if (!id) return
    const removed = this.form.llmConfigs.find((config) => config.id === id)
    if (!removed) return
    let llmConfigs = this.form.llmConfigs.filter((config) => config.id !== id)
    if (removed.isDefault && llmConfigs.length > 0 && !llmConfigs.some((config) => config.isDefault)) {
      llmConfigs = llmConfigs.map((config, index) => ({ ...config, isDefault: index === 0 }))
    }
    this.form = { ...this.form, llmConfigs }
    const drafts = { ...this.llmKeyDrafts }
    delete drafts[id]
    this.llmKeyDrafts = drafts
    const memory = { ...this.memoryLlmKeys }
    delete memory[id]
    this.memoryLlmKeys = memory
    if (this.selectedLlmId === id) {
      this.selectedLlmId = llmConfigs.find((config) => config.isDefault)?.id ?? llmConfigs[0]?.id ?? ''
    }
  }

  // Sectioned settings UI: picking a row selects it for editing and drops the
  // stale probe result from whichever config was tested before.
  selectLlmConfig(id: string) {
    if (!this.form.llmConfigs.some((config) => config.id === id)) return
    this.selectedLlmId = id
    this.llmTestResult = ''
  }

  setDefaultLlmConfig(id = this.selectedLlmId) {
    if (!id || !this.form.llmConfigs.some((config) => config.id === id)) return
    this.form = {
      ...this.form,
      llmConfigs: this.form.llmConfigs.map((config) => ({ ...config, isDefault: config.id === id })),
    }
  }

  patchLlmConfig(partial: { name?: string; provider?: string; model?: string; baseUrl?: string }) {
    const current = this.form.llmConfigs.find((config) => config.id === this.selectedLlmId)
    if (!current) return
    let model = current.model
    if (partial.provider !== undefined && partial.provider !== current.provider && partial.model === undefined) {
      const previousDefault = catalogDefaultModel(current.provider)
      if (!current.model.trim() || current.model === previousDefault) model = catalogDefaultModel(partial.provider)
    }
    if (partial.model !== undefined) model = partial.model
    const next: PublicLlmConfig = { ...current, ...partial, model }
    this.form = {
      ...this.form,
      llmConfigs: this.form.llmConfigs.map((config) => config.id === current.id ? next : config),
    }
  }

  setReleasesUrl(value: string) {
    this.form = { ...this.form, releasesUrl: value }
  }

  setGitEnabled(value: boolean) {
    this.form = { ...this.form, gitEnabled: value }
  }

  setAutoSyncMinutes(value: number) {
    const minutes = typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
    this.form = { ...this.form, autoSyncMinutes: minutes }
  }

  setAutoGitEnabled(value: boolean) {
    this.form = { ...this.form, autoGitEnabled: value === true }
  }

  setAutoGitIdleSeconds(value: number) {
    const seconds = typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
    this.form = { ...this.form, autoGitIdleSeconds: seconds }
  }

  setAutoGitBlurSeconds(value: number) {
    const seconds = typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
    this.form = { ...this.form, autoGitBlurSeconds: seconds }
  }

  setEmbeddingDim(value: string) {
    this.embeddingDimText = value
    const parsed = parsePositiveInt(value)
    // Empty or illegal stays off the real vector index. Do not coerce it to a usable width.
    this.patchEmbedding({ dim: parsed ?? 0 })
  }

  embeddingRuntime(): EmbeddingRuntime {
    const dim = parsePositiveInt(this.embeddingDimText)
    const endpoint = this.form.embedding.endpoint.trim()
    const model = this.form.embedding.model.trim()
    const apiKey = this.memoryEmbeddingKey
    const intended = endpoint !== '' && model !== '' && dim !== null
    const active = intended && apiKey !== ''
    return { endpoint, model, apiKey, dim: dim ?? 0, intended, active }
  }

  llmRuntime(): { provider: string; model: string; baseUrl: string; apiKey: string } | null {
    const config = this.form.llmConfigs.find((item) => item.isDefault)
    if (!config) return null
    return {
      provider: config.provider,
      model: config.model,
      baseUrl: effectiveBaseUrl(config),
      apiKey: this.memoryLlmKeys[config.id] ?? '',
    }
  }

  devLlmBaseUrl(baseUrl: string): string {
    if (!import.meta.env.DEV || !isHttpUrl(baseUrl)) return baseUrl
    try {
      const path = llmProxyBaseUrl(baseUrl)
      const origin = globalThis.location?.origin
      return origin && origin !== 'null' ? `${origin}${path}` : baseUrl
    } catch {
      return baseUrl
    }
  }

  // Overlapping calls share one read. A later call loads again.
  load(): Promise<void> {
    if (this.loadTask) return this.loadTask
    const task = this.loadBody().finally(() => {
      this.loadTask = null
      this.loaded = true
    })
    this.loadTask = task
    return task
  }

  waitUntilLoaded(): Promise<void> {
    if (this.loaded && !this.loadTask) return Promise.resolve()
    return this.load()
  }

  // Settings panel skeleton gate: true while the first read is in flight.
  get isLoading(): boolean {
    return this.loadTask !== null
  }

  async save() {
    const secrets = await this.openSecrets()
    if (!secrets) return
    let after: EmbeddingRuntime
    try {
      const embeddingKey = resolveKey(this.embeddingKey, this.memoryEmbeddingKey)
      const llmConfigs: LlmConfig[] = this.form.llmConfigs.map((config) => ({
        id: config.id,
        name: config.name,
        provider: config.provider,
        model: config.model,
        baseUrl: config.baseUrl,
        apiKey: resolveLlmKey(this.llmKeyDrafts[config.id], this.memoryLlmKeys[config.id] ?? ''),
        isDefault: config.isDefault,
      }))
      const dim = parsePositiveInt(this.embeddingDimText)
      const settings: AppSettings = {
        embedding: {
          endpoint: this.form.embedding.endpoint.trim(),
          model: this.form.embedding.model.trim(),
          apiKey: embeddingKey,
          dim: dim ?? 0,
        },
        llmConfigs,
        releasesUrl: this.form.releasesUrl,
        gitEnabled: this.form.gitEnabled,
        autoSyncMinutes: this.form.autoSyncMinutes,
        autoGitEnabled: this.form.autoGitEnabled,
        autoGitIdleSeconds: this.form.autoGitIdleSeconds,
        autoGitBlurSeconds: this.form.autoGitBlurSeconds,
        appearance: { ...this.form.appearance },
        editor: { ...this.form.editor },
        updates: { ...this.form.updates },
        privacy: { ...this.form.privacy },
      }
      const fs = await settingsFile()
      await writeSettings(fs, SETTINGS_FILE, settings, secrets)
      const written = await fs.readText(SETTINGS_FILE)
      const rawKeys = [embeddingKey, ...llmConfigs.map((config) => config.apiKey)].filter((key) => key)
      if (rawKeys.some((key) => written.includes(key))) {
        if (typeof localStorage !== 'undefined') localStorage.removeItem(SETTINGS_STORAGE_KEY)
        throw new Error('Refusing to keep a plaintext key')
      }
      if (typeof localStorage !== 'undefined') localStorage.setItem(SETTINGS_STORAGE_KEY, written)
      this.memoryEmbeddingKey = embeddingKey
      this.memoryLlmKeys = Object.fromEntries(llmConfigs.map((config) => [config.id, config.apiKey]))
      this.embeddingKey = ''
      this.llmKeyDrafts = {}
      this.embeddingDimText = dim === null ? this.embeddingDimText : String(dim)
      this.form = {
        embedding: {
          endpoint: settings.embedding.endpoint,
          model: settings.embedding.model,
          keyMask: maskSecret(embeddingKey),
          dim: dim ?? 0,
        },
        llmConfigs: llmConfigs.map((config) => ({
          id: config.id,
          name: config.name,
          provider: config.provider,
          model: config.model,
          baseUrl: config.baseUrl,
          keyMask: maskSecret(config.apiKey),
          isDefault: config.isDefault,
        })),
        releasesUrl: settings.releasesUrl,
        gitEnabled: settings.gitEnabled,
        autoSyncMinutes: settings.autoSyncMinutes,
        autoGitEnabled: settings.autoGitEnabled,
        autoGitIdleSeconds: settings.autoGitIdleSeconds,
        autoGitBlurSeconds: settings.autoGitBlurSeconds,
        appearance: settings.appearance,
        editor: settings.editor,
        updates: settings.updates,
        privacy: settings.privacy,
      }
      this.notice = ''
      after = this.embeddingRuntime()
    } catch (error) {
      this.notice = errorText(error)
      return
    }
    await this.syncVault(after)
  }

  async testEmbedding() {
    const dim = parsePositiveInt(this.embeddingDimText)
    if (dim === null) {
      this.embeddingTestResult = '维度不符'
      return
    }
    const settings: AppSettings['embedding'] = {
      endpoint: this.form.embedding.endpoint.trim(),
      model: this.form.embedding.model.trim(),
      apiKey: keyForTest(this.embeddingKey, this.memoryEmbeddingKey),
      dim,
    }
    try {
      const [vector] = await new EmbeddingClient((input, init) => globalThis.fetch(input, init)).embed(['连接测试'], settings)
      if (!vector || vector.length !== dim) {
        this.embeddingTestResult = `维度不符: expected ${dim}, got ${vector?.length ?? 0}`
        return
      }
      this.embeddingTestResult = '连接成功'
    } catch (error) {
      this.embeddingTestResult = errorText(error)
    }
  }

  async testSelectedLlm() {
    const current = this.form.llmConfigs.find((config) => config.id === this.selectedLlmId)
    if (!current) {
      this.llmTestResult = 'Missing model'
      return
    }
    const config: LlmConfig = {
      id: current.id,
      name: current.name,
      provider: current.provider,
      model: current.model,
      baseUrl: current.baseUrl,
      apiKey: keyForTest(this.llmKeyDrafts[current.id] ?? '', this.memoryLlmKeys[current.id] ?? ''),
      isDefault: current.isDefault,
    }
    const configured = effectiveBaseUrl(config)
    let baseUrl: string | undefined
    if (import.meta.env.DEV && isHttpUrl(configured)) {
      try {
        const path = llmProxyBaseUrl(configured)
        const origin = globalThis.location?.origin
        // pi-ai rejects a relative base URL. Same-origin keeps the request on the dev proxy.
        baseUrl = origin && origin !== 'null' ? `${origin}${path}` : path
      } catch {
        baseUrl = undefined
      }
    }
    const result = await testLlmConnection(config, { fetch: globalThis.fetch.bind(globalThis), baseUrl })
    this.llmTestResult = result.ok ? '连接成功' : result.error
  }

  private async loadBody() {
    const secrets = await this.openSecrets()
    if (!secrets) return
    try {
      const settings = await readSettings(await settingsFile(), SETTINGS_FILE, secrets)
      this.memoryEmbeddingKey = settings.embedding.apiKey
      this.memoryLlmKeys = Object.fromEntries(settings.llmConfigs.map((config) => [config.id, config.apiKey]))
      this.embeddingKey = ''
      this.llmKeyDrafts = {}
      this.embeddingDimText = settings.embedding.dim > 0 ? String(settings.embedding.dim) : ''
      const preferred = settings.llmConfigs.find((config) => config.isDefault) ?? settings.llmConfigs[0]
      this.selectedLlmId = preferred?.id ?? ''
      this.form = {
        embedding: {
          endpoint: settings.embedding.endpoint,
          model: settings.embedding.model,
          keyMask: maskSecret(settings.embedding.apiKey),
          dim: settings.embedding.dim,
        },
        llmConfigs: settings.llmConfigs.map((config) => ({
          id: config.id,
          name: config.name,
          provider: config.provider,
          model: config.model,
          baseUrl: config.baseUrl,
          keyMask: maskSecret(config.apiKey),
          isDefault: config.isDefault,
        })),
        releasesUrl: settings.releasesUrl,
        gitEnabled: settings.gitEnabled,
        autoSyncMinutes: settings.autoSyncMinutes,
        autoGitEnabled: settings.autoGitEnabled,
        autoGitIdleSeconds: settings.autoGitIdleSeconds,
        autoGitBlurSeconds: settings.autoGitBlurSeconds,
        appearance: settings.appearance,
        editor: settings.editor,
        updates: settings.updates,
        privacy: settings.privacy,
      }
      this.notice = ''
    } catch (error) {
      this.notice = errorText(error)
    }
  }

  private async openSecrets(): Promise<SecretsStore | null> {
    if (secretsOverride) {
      try {
        return typeof secretsOverride === 'function' ? await secretsOverride() : secretsOverride
      } catch (error) {
        this.notice = errorText(error)
        return null
      }
    }
    if (typeof globalThis.indexedDB === 'undefined' || !globalThis.indexedDB) return null
    try {
      return await webSecretsStore()
    } catch (error) {
      const message = errorText(error)
      if (message === 'IndexedDB is not available') return null
      this.notice = message
      return null
    }
  }

  private async syncVault(after: EmbeddingRuntime) {
    if (!has(VaultService)) return
    const vault = this.resolve(VaultService)
    const next = openedSignature(after)
    if (vault.phase === 'ready' && vault.fs && !sameIndexSignature(vault.indexSignature, next)) {
      await vault.reopenForSettings()
      return
    }
    if (!after.intended) vault.searchDegraded = false
    else if (!after.active) vault.searchDegraded = true
  }
}

export type UiHandoff = () => void | Promise<void>

// The downloaded asset is already a separate process. relaunch() would start
// this same build again, so the window only needs to exit.
async function exitTauriWindow(): Promise<void> {
  const { exit } = await import('@tauri-apps/plugin-process')
  await exit(0)
}

let uiHandoff: UiHandoff = exitTauriWindow

export function setUiHandoff(next: UiHandoff) {
  uiHandoff = next
}

export function resetUiHandoff() {
  uiHandoff = exitTauriWindow
}

// --- tauri-plugin-updater integration (T8.1) --------------------------------

export type UpdatePhase = 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'error'

export type UpdaterDownloadEvent =
  | { event: 'Started'; data: { contentLength?: number } }
  | { event: 'Progress'; data: { chunkLength: number } }
  | { event: 'Finished' }

// Structural match of the `Update` object returned by
// `@tauri-apps/plugin-updater`'s check().
export interface UpdaterUpdateInfo {
  version: string
  currentVersion: string
  body?: string
  date?: string
  download(onEvent?: (event: UpdaterDownloadEvent) => void): Promise<void>
  install(): Promise<void>
}

// What a single check should poll (T8.3). `endpoint` (the Releases URL
// setting) overrides everything; otherwise the channel picks the feed.
export interface UpdateQuery {
  channel: UpdateChannel
  endpoint: string
}

export interface UpdateCheckOptions {
  /** Manual checks re-offer a version the user dismissed from the banner. */
  ignoreDismissed?: boolean
}

export interface UpdaterDriver {
  check(query?: UpdateQuery): Promise<UpdaterUpdateInfo | null>
  relaunch(): Promise<void>
}

let updaterDriverForTests: UpdaterDriver | null = null

export function setUpdaterDriverForTests(driver: UpdaterDriver | null) {
  updaterDriverForTests = driver
}

const DISMISSED_UPDATE_KEY = 'stride.update.dismissed'

// Channel feeds (T8.3). The stable feed lives in tauri.conf.json
// (`plugins.updater.endpoints`) and is served by the plugin itself — full
// signature-verified download + install. The plugin's check() takes no
// endpoint override, so every non-stable query uses a fetch-based fallback:
// poll the channel manifest, compare versions in JS.
//
// The beta feed is the GitHub *API* URL of the fixed `beta-latest` release
// tag (the T8.4 pipeline keeps that tag pointing at the newest beta), NOT a
// latest.json under releases/download/: api.github.com answers with
// `Access-Control-Allow-Origin: *` so the Tauri webview may fetch it
// directly (release asset download URLs carry no CORS headers and would be
// blocked by WKWebView), and one request already returns
// tag_name/body/published_at/html_url.
export const BETA_UPDATE_ENDPOINT = 'https://api.github.com/repos/ximing/stride/releases/tags/beta-latest'

// Normalized result of a fallback manifest poll.
export interface StaticUpdateOffer {
  version: string
  currentVersion: string
  body: string
  date: string
  pageUrl: string
}

// Accepts both the tauri static latest.json shape ({version, notes,
// pub_date, platforms}) and the GitHub release API shape ({tag_name, body,
// published_at, html_url}). Returns null when the payload is malformed or
// does not offer a version newer than `currentVersion` (never downgrades).
export function parseStaticUpdateManifest(data: unknown, currentVersion: string): StaticUpdateOffer | null {
  if (!data || typeof data !== 'object') return null
  const record = data as Record<string, unknown>
  let version = ''
  let body = ''
  let date = ''
  let pageUrl = ''
  if (typeof record.tag_name === 'string') {
    version = record.tag_name
    body = typeof record.body === 'string' ? record.body : ''
    date = typeof record.published_at === 'string' ? record.published_at : ''
    pageUrl = typeof record.html_url === 'string' ? record.html_url : ''
  } else if (typeof record.version === 'string') {
    version = record.version
    body = typeof record.notes === 'string' ? record.notes : typeof record.body === 'string' ? record.body : ''
    date = typeof record.pub_date === 'string' ? record.pub_date : typeof record.date === 'string' ? record.date : ''
  } else {
    return null
  }
  if (compareVersions(version, currentVersion) <= 0) return null
  return { version: version.replace(/^v/, ''), currentVersion, body, date, pageUrl }
}

// Fallback offer from a runtime-chosen endpoint (beta channel or custom
// Releases URL). The plugin cannot download from an endpoint it did not
// poll, so the in-app download hands off to the system browser: download()
// opens the release page and then throws, which UpdateService treats as a
// silent failure and returns to idle.
class StaticUpdateInfo implements UpdaterUpdateInfo {
  constructor(private readonly offer: StaticUpdateOffer) {}

  get version() {
    return this.offer.version
  }
  get currentVersion() {
    return this.offer.currentVersion
  }
  get body() {
    return this.offer.body || undefined
  }
  get date() {
    return this.offer.date || undefined
  }

  async download(): Promise<void> {
    if (this.offer.pageUrl) {
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        await invoke('plugin:shell|open', { path: this.offer.pageUrl })
      } catch {
        // Opening the browser is best-effort (needs the shell:allow-open capability).
      }
    }
    throw new Error('manual download required')
  }

  async install(): Promise<void> {
    throw new Error('manual install required')
  }
}

async function checkStaticEndpoint(url: string): Promise<UpdaterUpdateInfo | null> {
  const { getVersion } = await import('@tauri-apps/api/app')
  const currentVersion = await getVersion()
  const response = await fetch(url, { headers: { Accept: 'application/vnd.github+json' } })
  if (!response.ok) return null
  const data: unknown = await response.json()
  const offer = parseStaticUpdateManifest(data, currentVersion)
  return offer ? new StaticUpdateInfo(offer) : null
}

async function loadUpdaterDriver(): Promise<UpdaterDriver | null> {
  if (updaterDriverForTests) return updaterDriverForTests
  if (!tauriRuntime()) return null
  const [updater, process] = await Promise.all([
    import('@tauri-apps/plugin-updater'),
    import('@tauri-apps/plugin-process'),
  ])
  return {
    check: (query) => {
      const endpoint = query?.endpoint.trim() ?? ''
      // Custom Releases URL wins; then the beta channel; the default goes
      // through the plugin's configured (stable) endpoints.
      if (endpoint) return checkStaticEndpoint(endpoint)
      if (query?.channel === 'beta') return checkStaticEndpoint(BETA_UPDATE_ENDPOINT)
      return updater.check()
    },
    relaunch: () => process.relaunch(),
  }
}

export class UpdateService extends Service {
  phase: UpdatePhase = 'idle'
  progress = 0
  version = ''
  current = ''
  error = ''
  body = ''
  date = ''

  private pending: UpdaterUpdateInfo | null = null
  private expectedVersion = ''
  private driver: UpdaterDriver | null = null

  private async ensureDriver(): Promise<UpdaterDriver | null> {
    if (this.driver) return this.driver
    const driver = await loadUpdaterDriver()
    if (driver) this.driver = driver
    return driver
  }

  private dismissedVersion(): string {
    try {
      return globalThis.localStorage?.getItem(DISMISSED_UPDATE_KEY) ?? ''
    } catch {
      return ''
    }
  }

  private rememberDismissed(version: string) {
    try {
      globalThis.localStorage?.setItem(DISMISSED_UPDATE_KEY, version)
    } catch {
      // Storage is best-effort; a forgotten dismissal only means the banner returns.
    }
  }

  // The version offered must be newer than the running build: never downgrade.
  private offersUpgrade(update: UpdaterUpdateInfo): boolean {
    return compareVersions(update.version, update.currentVersion) > 0
  }

  // Whether any updater can run here at all (Tauri runtime or an injected
  // test driver). UI hides check-for-updates affordances when false.
  get updaterSupported(): boolean {
    return updaterDriverForTests !== null || tauriRuntime()
  }

  // Read the persisted preference at check time so settings edits apply to
  // the very next check without restarting anything.
  private updateQuery(): UpdateQuery {
    if (has(SettingsService)) {
      const settings = this.resolve(SettingsService)
      return { channel: settings.form.updates.channel, endpoint: settings.form.releasesUrl.trim() }
    }
    return { channel: 'stable', endpoint: '' }
  }

  async check(options?: UpdateCheckOptions) {
    if (this.phase === 'checking' || this.phase === 'downloading') return
    const driver = await this.ensureDriver()
    // Outside Tauri (plain browser dev) there is no updater: stay idle.
    if (!driver) return
    this.phase = 'checking'
    this.error = ''
    let update: UpdaterUpdateInfo | null
    try {
      update = await driver.check(this.updateQuery())
    } catch {
      // Network failures are silent: no banner, no error.
      this.phase = 'idle'
      return
    }
    if (!update || !this.offersUpgrade(update)) {
      this.phase = 'idle'
      return
    }
    if (!options?.ignoreDismissed && this.dismissedVersion() === update.version) {
      this.phase = 'idle'
      return
    }
    this.pending = update
    this.expectedVersion = update.version
    this.version = update.version
    this.current = update.currentVersion
    this.body = update.body ?? ''
    this.date = update.date ?? ''
    this.progress = 0
    this.phase = 'available'
  }

  async download() {
    if (this.phase !== 'available' || !this.pending) return
    const update = this.pending
    this.phase = 'downloading'
    this.progress = 0
    this.error = ''
    let total = 0
    let received = 0
    try {
      await update.download((event) => {
        if (event.event === 'Started') {
          total = event.data.contentLength ?? 0
        } else if (event.event === 'Progress') {
          received += event.data.chunkLength
          this.progress = total > 0 ? Math.min(received / total, 1) : 0
        } else if (event.event === 'Finished') {
          this.progress = 1
        }
      })
    } catch {
      // Download failures are silent; a later check re-offers the update.
      this.pending = null
      this.progress = 0
      this.phase = 'idle'
      return
    }
    // Second-pass verification: what we downloaded must still be the version
    // we announced, and still newer than the running build.
    if (update.version !== this.expectedVersion || compareVersions(update.version, this.current) <= 0) {
      this.pending = null
      this.error = 'Update verification failed'
      this.phase = 'error'
      return
    }
    this.progress = 1
    this.phase = 'ready'
  }

  async dismiss() {
    if (this.version) this.rememberDismissed(this.version)
    this.pending = null
    this.expectedVersion = ''
    this.version = ''
    this.body = ''
    this.date = ''
    this.progress = 0
    this.error = ''
    this.phase = 'idle'
  }

  async confirm() {
    if (this.phase !== 'ready' || !this.pending) return
    const update = this.pending
    // Final verification before touching the install: refuse downgrades and
    // any drift from the version the user accepted.
    if (update.version !== this.expectedVersion || compareVersions(update.version, this.current) <= 0) {
      this.pending = null
      this.error = 'Update verification failed'
      this.phase = 'error'
      return
    }
    const driver = await this.ensureDriver()
    if (!driver) return
    try {
      await update.install()
      await driver.relaunch()
    } catch (error) {
      this.error = errorText(error)
      this.phase = 'error'
    }
  }
}
