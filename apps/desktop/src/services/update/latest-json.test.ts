import { has, register, resolve } from '@rabjs/react'
import { compareVersions } from '@stride/core'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setUpdaterDriverForTests, UpdateService, type UpdaterUpdateInfo } from './update.service'

const desktopRoot = join(__dirname, '../../..')
const builderConfig = readFileSync(join(desktopRoot, 'electron-builder.yml'), 'utf8')
const appVersion = (
  JSON.parse(readFileSync(join(desktopRoot, 'package.json'), 'utf8')) as { version: string }
).version

/** electron-updater latest-mac.yml shape, reduced to the fields the driver reads. */
function simulatedLatestMac(version: string) {
  return {
    version,
    releaseDate: '2026-10-16T00:00:00Z',
    releaseNotes: 'Simulated release for the local update-check verification.',
    path: `Stride-${version}-arm64-mac.zip`,
    files: [
      { url: `Stride-${version}-arm64-mac.zip`, sha512: 'abc' },
      { url: `Stride-${version}-mac.zip`, sha512: 'def' },
    ],
  }
}

async function simulatedCheck(
  currentVersion: string,
  fetchImpl: typeof fetch,
): Promise<UpdaterUpdateInfo | null> {
  const response = await fetchImpl(
    'https://github.com/ximing/stride/releases/latest/download/latest-mac.yml',
  )
  if (!response.ok) throw new Error(`endpoint returned ${response.status}`)
  const manifest = (await response.json()) as {
    version?: string
    releaseNotes?: string
    releaseDate?: string
    path?: string
  }
  if (!manifest.version || !manifest.path) return null
  if (compareVersions(manifest.version, currentVersion) <= 0) return null
  return {
    version: manifest.version,
    currentVersion,
    body: manifest.releaseNotes,
    date: manifest.releaseDate,
    async download() {},
    async install() {},
  }
}

function freshUpdates(): UpdateService {
  if (!has(UpdateService)) register(UpdateService)
  const updates = resolve(UpdateService)
  Object.assign(updates, {
    phase: 'idle',
    progress: 0,
    version: '',
    current: '',
    error: '',
    body: '',
    date: '',
    pending: null,
    expectedVersion: '',
    driver: null,
  })
  return updates
}

describe('electron-updater release metadata', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    setUpdaterDriverForTests(null)
  })

  it('publishes GitHub metadata for mac zip, Linux AppImage, and Windows NSIS', () => {
    expect(builderConfig).toContain('provider: github')
    expect(builderConfig).toContain('owner: ximing')
    expect(builderConfig).toContain('repo: stride')
    expect(builderConfig).toMatch(/mac:[\s\S]*- zip/)
    expect(builderConfig).toMatch(/linux:[\s\S]*- AppImage/)
    expect(builderConfig).toMatch(/win:[\s\S]*- nsis/)
    expect(appVersion).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('parses a newer updater manifest and offers it', async () => {
    const manifest = simulatedLatestMac('9.9.9')
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(manifest), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const updates = freshUpdates()
    setUpdaterDriverForTests({
      check: () => simulatedCheck('0.1.0', fetch),
      async relaunch() {},
    })
    await updates.check()

    expect(fetchMock).toHaveBeenCalledWith(
      'https://github.com/ximing/stride/releases/latest/download/latest-mac.yml',
    )
    expect(updates.phase).toBe('available')
    expect(updates.version).toBe('9.9.9')
    expect(updates.current).toBe('0.1.0')
    expect(updates.body).toBe(manifest.releaseNotes)

    await updates.download()
    expect(updates.phase).toBe('ready')
  })

  it('offers nothing when the manifest is not newer than the app', async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify(simulatedLatestMac(appVersion)), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const updates = freshUpdates()
    setUpdaterDriverForTests({
      check: () => simulatedCheck(appVersion, fetch),
      async relaunch() {},
    })
    await updates.check()
    expect(updates.phase).toBe('idle')
    expect(updates.error).toBe('')
  })
})
