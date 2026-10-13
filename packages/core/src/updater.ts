import fs from 'node:fs'
import path from 'node:path'

export interface ReleaseAsset {
  name: string
  browser_download_url: string
}

export interface GithubRelease {
  tag_name: string
  draft?: boolean
  prerelease?: boolean
  assets?: ReleaseAsset[]
}

export interface SelectedUpdate {
  version: string
  assetName: string
  assetUrl: string
}

export type DownloadEvent =
  | { event: 'Started'; data: { contentLength?: number } }
  | { event: 'Progress'; data: { chunkLength: number } }
  | { event: 'Finished' }

export type UpdatePhase = 'idle' | 'available' | 'downloading' | 'ready'

export function parseVersion(tag: string): number[] {
  const base = tag.trim().replace(/^v/i, '').split('+')[0] ?? ''
  const parts = base.split('.').map((part) => {
    const match = /^(\d+)/.exec(part)
    return match ? Number(match[1]) : 0
  })
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0]
}

export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a)
  const right = parseVersion(b)
  for (let i = 0; i < 3; i += 1) {
    if (left[i]! > right[i]!) return 1
    if (left[i]! < right[i]!) return -1
  }
  return 0
}

export function selectUpdate(releases: GithubRelease[], current: string): SelectedUpdate | null {
  const newer = releases
    .filter((release) => !release.draft && release.tag_name && compareVersions(release.tag_name, current) > 0)
    .sort((a, b) => compareVersions(b.tag_name, a.tag_name))
  const chosen = newer[0]
  const asset = chosen?.assets?.find((item) => item.browser_download_url && item.name)
  if (!chosen || !asset) return null
  return { version: chosen.tag_name, assetName: asset.name, assetUrl: asset.browser_download_url }
}

export async function downloadAsset(
  url: string,
  dest: string,
  onEvent: (event: DownloadEvent) => void,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const response = await fetchImpl(url)
  if (!response.ok || !response.body) throw new Error(`Download failed (${response.status})`)
  const total = Number(response.headers.get('content-length') || 0)
  onEvent({ event: 'Started', data: { contentLength: total || undefined } })
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  while (true) {
    const step = await reader.read()
    if (step.done) break
    if (step.value) {
      chunks.push(step.value)
      onEvent({ event: 'Progress', data: { chunkLength: step.value.byteLength } })
    }
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.writeFileSync(dest, Buffer.concat(chunks))
  onEvent({ event: 'Finished' })
}

export function installReleaseAsset(downloadedTo: string, installPath: string): void {
  if (!downloadedTo || !fs.existsSync(downloadedTo)) throw new Error('Downloaded update is missing')
  const bytes = fs.readFileSync(downloadedTo)
  if (bytes.length === 0) throw new Error('Downloaded update is empty')
  fs.mkdirSync(path.dirname(installPath), { recursive: true })
  const staged = `${installPath}.next`
  fs.writeFileSync(staged, bytes)
  fs.chmodSync(staged, 0o755)
  fs.renameSync(staged, installPath)
}

export class UpdateController {
  phase: UpdatePhase = 'idle'
  progress = 0
  selected: SelectedUpdate | null = null
  downloadedTo = ''
  relaunchCount = 0
  events: DownloadEvent[] = []
  readonly installPath: string

  constructor(
    private currentVersion: string,
    private fetchImpl: typeof fetch,
    private relaunchImpl: (installPath: string) => void | Promise<void>,
    private marker: { file: string; installPath: string },
  ) {
    this.installPath = marker.installPath
    if (!this.installPath) throw new Error('Update install path is required')
  }

  markerValue(): string {
    if (!fs.existsSync(this.marker.file)) return this.currentVersion
    return fs.readFileSync(this.marker.file, 'utf8').trim() || this.currentVersion
  }

  private writeMarker(version: string) {
    fs.mkdirSync(path.dirname(this.marker.file), { recursive: true })
    fs.writeFileSync(this.marker.file, `${version}\n`)
  }

  async check(releases: GithubRelease[] | string): Promise<SelectedUpdate | null> {
    const list = typeof releases === 'string'
      ? (await (await this.fetchImpl(releases)).json()) as GithubRelease[]
      : releases
    const installed = this.markerValue()
    this.selected = selectUpdate(list, installed)
    this.phase = this.selected ? 'available' : 'idle'
    this.progress = 0
    return this.selected
  }

  async download(dest: string): Promise<void> {
    if (!this.selected) throw new Error('No update to download')
    const version = this.selected.version
    const url = this.selected.assetUrl
    this.phase = 'downloading'
    this.progress = 0
    let total = 0
    let got = 0
    await downloadAsset(url, dest, (event) => {
      this.events.push(event)
      if (event.event === 'Started') total = event.data.contentLength ?? 0
      if (event.event === 'Progress') {
        got += event.data.chunkLength
        this.progress = total > 0 ? Math.min(got / total, 1) : 0
      }
    }, this.fetchImpl)
    this.downloadedTo = dest
    this.progress = 1
    this.phase = 'ready'
    this.selected = { version, assetName: this.selected.assetName, assetUrl: url }
  }

  dismiss(): void {
    this.phase = 'idle'
    this.selected = null
    this.progress = 0
  }

  async confirm(): Promise<void> {
    if (this.phase !== 'ready' || !this.selected) throw new Error('Update is not ready')
    const previous = this.markerValue()
    const next = this.selected.version
    const previousBytes = fs.existsSync(this.installPath) ? fs.readFileSync(this.installPath) : null
    installReleaseAsset(this.downloadedTo, this.installPath)
    this.writeMarker(next)
    try {
      await this.relaunchImpl(this.installPath)
    } catch (error) {
      this.writeMarker(previous)
      if (previousBytes) {
        fs.writeFileSync(this.installPath, previousBytes)
        fs.chmodSync(this.installPath, 0o755)
      } else {
        fs.rmSync(this.installPath, { force: true })
      }
      throw error
    }
    this.relaunchCount += 1
  }
}
