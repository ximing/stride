import { Service } from '@rabjs/react'
import { api, type PublicSettings, type UpdateView } from '../api'
import { VaultService } from './vault.service'

const emptySettings = (): PublicSettings => ({
  embedding: { endpoint: '', model: '', keyMask: '', dim: 4 },
  llm: { provider: '', model: '', baseUrl: '', keyMask: '' },
  releasesUrl: '',
})

export class GitService extends Service {
  status = ''
  diff = ''
  history = ''
  message = ''
  remote = ''
  output = ''
  conflicts: string[] = []

  private get vault() {
    return this.resolve(VaultService)
  }

  setMessage(value: string) {
    this.message = value
  }

  setRemote(value: string) {
    this.remote = value
  }

  async refresh() {
    try {
      const status = await api.gitStatus()
      this.status = status.repo ? status.porcelain || 'Clean' : 'Not a git repository'
      const id = this.vault.activeId
      this.diff = (await api.gitDiff(id || undefined)).diff
      const history = await api.gitHistory(id || undefined)
      this.history = history.history.map((commit) => `${commit.hash.slice(0, 7)} ${commit.subject}`).join('\n')
    } catch (error) {
      this.output = error instanceof Error ? error.message : String(error)
    }
  }

  async init() {
    try {
      await api.gitInit()
      this.output = 'Git repository initialized'
      await this.refresh()
    } catch (error) {
      this.output = error instanceof Error ? error.message : String(error)
    }
  }

  async commit() {
    try {
      await this.vault.flush()
      const result = await api.gitCommit(this.message)
      this.output = result.output
      this.message = ''
      await this.refresh()
    } catch (error) {
      this.output = error instanceof Error ? error.message : String(error)
    }
  }

  async pull() {
    try {
      this.vault.cancelPending()
      const result = await api.gitPull()
      this.vault.adopt(result.notes)
      this.conflicts = result.files.map((file) => file.replace(/\.stride\.json$/, ''))
      this.output = result.conflict ? `Conflict in ${result.files.join(', ')}` : result.output || 'Pulled'
      await this.refresh()
    } catch (error) {
      this.output = error instanceof Error ? error.message : String(error)
    }
  }

  async push() {
    try {
      if (this.remote.trim()) await api.gitRemote(this.remote.trim())
      const result = await api.gitPush()
      this.output = result.output || 'Pushed'
    } catch (error) {
      this.output = error instanceof Error ? error.message : String(error)
    }
  }

  async keepSide(id: string, side: 'ours' | 'theirs') {
    try {
      this.vault.cancelPending()
      const result = await api.gitResolve(id, side)
      this.vault.adopt(result.notes)
      this.conflicts = this.conflicts.filter((item) => item !== id)
      this.output = `Kept ${side} for ${id}`
      await this.refresh()
    } catch (error) {
      this.output = error instanceof Error ? error.message : String(error)
    }
  }
}

export class ChatService extends Service {
  draft = ''
  lines: { role: 'user' | 'assistant'; text: string }[] = []
  error = ''

  private get vault() {
    return this.resolve(VaultService)
  }

  setDraft(value: string) {
    this.draft = value
  }

  async send() {
    const message = this.draft.trim()
    if (!message) return
    this.draft = ''
    this.error = ''
    try {
      const result = await api.chat(message, this.vault.activeId)
      this.lines = result.history
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error)
    }
  }
}

export class SettingsService extends Service {
  form = emptySettings()
  embeddingKey = ''
  llmKey = ''
  notice = ''

  patchEmbedding(partial: Partial<PublicSettings['embedding']>) {
    this.form = { ...this.form, embedding: { ...this.form.embedding, ...partial } }
  }

  patchLlm(partial: Partial<PublicSettings['llm']>) {
    this.form = { ...this.form, llm: { ...this.form.llm, ...partial } }
  }

  setReleasesUrl(value: string) {
    this.form = { ...this.form, releasesUrl: value }
  }

  async load() {
    try {
      this.form = await api.settings()
      this.embeddingKey = this.form.embedding.keyMask
      this.llmKey = this.form.llm.keyMask
    } catch (error) {
      this.notice = error instanceof Error ? error.message : String(error)
    }
  }

  async save() {
    try {
      this.form = await api.saveSettings({
        embedding: { ...this.form.embedding, apiKey: this.embeddingKey },
        llm: { ...this.form.llm, apiKey: this.llmKey },
        releasesUrl: this.form.releasesUrl,
      })
      this.embeddingKey = this.form.embedding.keyMask
      this.llmKey = this.form.llm.keyMask
      this.notice = 'Settings saved. Keys stay outside the vault.'
    } catch (error) {
      this.notice = error instanceof Error ? error.message : String(error)
    }
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

export class UpdateService extends Service {
  phase: UpdateView['phase'] = 'idle'
  progress = 0
  version = ''
  current = ''
  error = ''
  private timer: ReturnType<typeof setInterval> | null = null

  async check() {
    this.error = ''
    try {
      const view = await api.checkUpdates()
      this.apply(view)
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error)
    }
  }

  async download() {
    this.phase = 'downloading'
    this.timer = setInterval(() => {
      void api.updates().then((view) => this.apply(view)).catch(() => undefined)
    }, 200)
    try {
      this.apply(await api.downloadUpdate())
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error)
      this.phase = 'available'
    } finally {
      if (this.timer) clearInterval(this.timer)
      this.timer = null
    }
  }

  async dismiss() {
    const before = this.current
    const view = await api.dismissUpdate()
    this.apply(view)
    this.current = view.version || before
  }

  async confirm() {
    this.error = ''
    try {
      const view = await api.confirmUpdate()
      this.apply(view)
      if (view.restartRequested) await uiHandoff()
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error)
      if (this.phase === 'ready') this.phase = 'available'
    }
  }

  private apply(view: UpdateView) {
    this.phase = view.phase
    this.progress = view.progress
    this.version = view.selected?.version || ''
    this.current = view.version
  }
}
