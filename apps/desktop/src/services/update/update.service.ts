import { has, Service } from '@rabjs/react'
import { compareVersions, type UpdateChannel } from '@stride/core'
import { isDesktopRuntime } from '../platform/runtime'
import { SettingsService } from '../settings/settings.service'

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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
  if (!isDesktopRuntime()) return null
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
    return updaterDriverForTests !== null || isDesktopRuntime()
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
