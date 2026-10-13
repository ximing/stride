import { Service } from '@rabjs/react'
import { browserGitBackend } from '@stride/git-web'
import { VaultService } from './vault.service'

interface PublicSettings {
  embedding: { endpoint: string; model: string; keyMask: string; dim: number }
  llm: { provider: string; model: string; baseUrl: string; keyMask: string }
  releasesUrl: string
}

const emptySettings = (): PublicSettings => ({
  embedding: { endpoint: '', model: '', keyMask: '', dim: 4 },
  llm: { provider: '', model: '', baseUrl: '', keyMask: '' },
  releasesUrl: '',
})

const GIT_BROWSER = 'Git is not available in the browser'

export class GitService extends Service {
  status = ''
  diff = ''
  history = ''
  message = ''
  remote = ''
  output = ''
  conflicts: string[] = []
  private readonly git = browserGitBackend()

  constructor() {
    super()
    if (!this.git.available) this.output = GIT_BROWSER
  }

  private get vault() {
    return this.resolve(VaultService)
  }

  setMessage(value: string) {
    this.message = value
  }

  setRemote(value: string) {
    this.remote = value
  }

  private browserBlocked(): boolean {
    if (this.git.available) return false
    this.output = GIT_BROWSER
    return true
  }

  async refresh() {
    if (this.browserBlocked()) return
  }

  async init() {
    if (this.browserBlocked()) return
  }

  async commit() {
    try {
      await this.vault.flush()
    } catch (error) {
      this.output = error instanceof Error ? error.message : String(error)
      return
    }
    if (this.browserBlocked()) return
  }

  async pull() {
    if (this.browserBlocked()) return
  }

  async push() {
    if (this.browserBlocked()) return
  }

  async keepSide(_id: string, _side: 'ours' | 'theirs') {
    if (this.browserBlocked()) return
  }
}

export class ChatService extends Service {
  draft = ''
  lines: { role: 'user' | 'assistant'; text: string }[] = []
  error = ''

  setDraft(value: string) {
    this.draft = value
  }

  async send() {
    if (!this.draft.trim()) return
    this.error = 'Agent is not available in the browser'
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

  async load() {}

  async save() {}
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
  phase: 'idle' | 'available' | 'downloading' | 'ready' = 'idle'
  progress = 0
  version = ''
  current = ''
  error = ''

  async check() {}

  async download() {}

  async dismiss() {}

  async confirm() {}
}
