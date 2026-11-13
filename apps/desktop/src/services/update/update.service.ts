import { has, Service } from '@rabjs/react'
import { compareVersions, type UpdateChannel } from '@stride/core'
import type { UpdaterEvent } from '@stride/electron-api'
import { hostFetch } from '../platform/host-fetch'
import { isDesktopRuntime } from '../platform/runtime'
import { SettingsService } from '../settings/settings.service'

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// --- desktop updater (stable download/install, custom/beta page handoff) ----

export type UpdatePhase = 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'error'

export type UpdaterDownloadEvent =
  | { event: 'Started'; data: { contentLength?: number } }
  | { event: 'Progress'; data: { chunkLength: number } }
  | { event: 'Finished' }

// What `download()` reports while a stable update is streaming.
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

// Channel feeds. The stable feed is the packaged updater: full download and
// install. A custom Releases URL or the beta channel cannot use that feed, so
// they poll a manifest and hand the release page to the system browser.
//
// The beta feed is the GitHub API URL of the fixed `beta-latest` release tag.
// One request returns tag_name, body, published_at, and html_url.
export const BETA_UPDATE_ENDPOINT = 'https://api.github.com/repos/ximing/stride/releases/tags/beta-latest'

// Normalized result of a fallback manifest poll.
export interface StaticUpdateOffer {
  version: string
  currentVersion: string
  body: string
  date: string
  pageUrl: string
}

// Accepts both the static latest.json shape ({version, notes,
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
// Releases URL). Download opens the release page and then throws, which
// UpdateService treats as a silent failure and returns to idle.
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
        const { electronBridge } = await import('@stride/electron-api')
        await electronBridge().invoke('host:openExternal', { url: this.offer.pageUrl })
      } catch {
        // Opening the browser is best-effort.
      }
    }
    throw new Error('manual download required')
  }

  async install(): Promise<void> {
    throw new Error('manual install required')
  }
}

async function checkStaticEndpoint(url: string): Promise<UpdaterUpdateInfo | null> {
  const { electronBridge } = await import('@stride/electron-api')
  const info = await electronBridge().invoke<{ version?: unknown }>('app:info')
  const currentVersion = info && typeof info.version === 'string' ? info.version : ''
  const response = await hostFetch(url, { headers: { Accept: 'application/vnd.github+json' } })
  if (!response.ok) return null
  const data: unknown = await response.json()
  const offer = parseStaticUpdateManifest(data, currentVersion)
  return offer ? new StaticUpdateInfo(offer) : null
}

function mapStableDownload(
  onEvent: ((event: UpdaterDownloadEvent) => void) | undefined,
  listen: (listener: (event: UpdaterEvent) => void) => () => void,
): () => void {
  let announced = false
  let seen = 0
  return listen((event) => {
    if (!onEvent) return
    if (event.type === 'Progress') {
      if (!announced) {
        onEvent({ event: 'Started', data: { contentLength: event.total } })
        announced = true
      }
      const chunkLength = Math.max(0, event.transferred - seen)
      seen = event.transferred
      onEvent({ event: 'Progress', data: { chunkLength } })
      return
    }
    if (event.type === 'Finished') {
      if (!announced) onEvent({ event: 'Started', data: {} })
      onEvent({ event: 'Finished' })
    }
  })
}

async function loadUpdaterDriver(): Promise<UpdaterDriver | null> {
  if (updaterDriverForTests) return updaterDriverForTests
  if (!isDesktopRuntime()) return null
  const updater = await import('@stride/electron-api')
  return {
    check: async (query) => {
      const endpoint = query?.endpoint.trim() ?? ''
      // Custom Releases URL wins; then the beta channel; stable uses the packaged updater.
      if (endpoint) return checkStaticEndpoint(endpoint)
      if (query?.channel === 'beta') return checkStaticEndpoint(BETA_UPDATE_ENDPOINT)
      const offer = await updater.checkForUpdate()
      if (!offer) return null
      return {
        version: offer.version,
        currentVersion: offer.currentVersion,
        body: offer.body ?? undefined,
        date: offer.date ?? undefined,
        async download(onEvent) {
          const stop = mapStableDownload(onEvent, updater.onUpdaterEvent)
          try {
            await updater.downloadUpdate()
          } finally {
            stop()
          }
        },
        install: () => updater.installUpdate(),
      }
    },
    relaunch: () => updater.relaunchAfterUpdate(),
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

  // Whether any updater can run here at all (desktop runtime or an injected
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
    // Outside the desktop app (plain browser dev) there is no updater: stay idle.
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
      // Stable install is quitAndInstall: it quits this process and starts the
      // installer. relaunch() would start the build that is about to be replaced.
      // Custom and beta offers throw from install() and never reach a relaunch.
      await update.install()
    } catch (error) {
      this.error = errorText(error)
      this.phase = 'error'
    }
  }
}
