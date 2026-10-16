import { has, register, resolve } from '@rabjs/react'
import { compareVersions } from '@stride/core'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setUpdaterDriverForTests, UpdateService, type UpdaterUpdateInfo } from './panels.service'

const appConfig = JSON.parse(
  readFileSync(join(__dirname, '../../src-tauri/tauri.conf.json'), 'utf8'),
) as {
  version: string
  plugins: { updater: { active: boolean; pubkey: string; endpoints: string[] } }
}

// Simulates the static manifest T8.4 will publish to
// https://github.com/ximing/stride/releases/latest/download/latest.json
// (tauri-plugin-updater "static JSON" format).
function simulatedLatestJson(version: string) {
  return {
    version,
    notes: 'Simulated release for the local update-check verification.',
    pub_date: '2026-10-16T00:00:00Z',
    platforms: {
      'darwin-aarch64': {
        signature: 'dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNpZ25lcgo=',
        url: `https://github.com/ximing/stride/releases/download/v${version}/Stride_aarch64.app.tar.gz`,
      },
      'darwin-x86_64': {
        signature: 'dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNpZ25lcgo=',
        url: `https://github.com/ximing/stride/releases/download/v${version}/Stride_x64.app.tar.gz`,
      },
    },
  }
}

// Mirrors what tauri-plugin-updater's check() does with a static endpoint:
// GET the manifest, parse it, compare against the running version.
async function simulatedCheck(
  currentVersion: string,
  fetchImpl: typeof fetch,
): Promise<UpdaterUpdateInfo | null> {
  const endpoint = appConfig.plugins.updater.endpoints[0]!
  const response = await fetchImpl(endpoint)
  if (!response.ok) throw new Error(`endpoint returned ${response.status}`)
  const manifest = (await response.json()) as {
    version?: string
    notes?: string
    pub_date?: string
    platforms?: Record<string, { signature?: string; url?: string }>
  }
  if (!manifest.version || compareVersions(manifest.version, currentVersion) <= 0) return null
  const platform = manifest.platforms?.['darwin-aarch64']
  if (!platform?.signature || !platform.url) return null
  return {
    version: manifest.version,
    currentVersion,
    body: manifest.notes,
    date: manifest.pub_date,
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

describe('latest.json endpoint simulation', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    setUpdaterDriverForTests(null)
  })

  it('configures the stable static endpoint and a minisign pubkey', () => {
    const updater = appConfig.plugins.updater
    expect(updater.active).toBe(true)
    expect(updater.endpoints).toEqual([
      'https://github.com/ximing/stride/releases/latest/download/latest.json',
    ])
    // minisign public key file content: two base64 lines, no private material.
    const lines = updater.pubkey.split('\n')
    expect(lines).toHaveLength(2)
    for (const line of lines) {
      expect(() => atob(line)).not.toThrow()
    }
    expect(atob(lines[0]!)).toContain('minisign public key')
  })

  it('parses a served latest.json with a fake higher version and offers it', async () => {
    const manifest = simulatedLatestJson('9.9.9')
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(manifest), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const updates = freshUpdates()
    setUpdaterDriverForTests({
      check: () => simulatedCheck('0.1.0', fetch),
      async relaunch() {},
    })
    await updates.check()

    expect(fetchMock).toHaveBeenCalledWith(
      'https://github.com/ximing/stride/releases/latest/download/latest.json',
    )
    expect(updates.phase).toBe('available')
    expect(updates.version).toBe('9.9.9')
    expect(updates.current).toBe('0.1.0')
    expect(updates.body).toBe(manifest.notes)

    await updates.download()
    expect(updates.phase).toBe('ready')
  })

  it('offers nothing when the manifest is not newer than the app', async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify(simulatedLatestJson(appConfig.version)), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const updates = freshUpdates()
    setUpdaterDriverForTests({
      check: () => simulatedCheck(appConfig.version, fetch),
      async relaunch() {},
    })
    await updates.check()
    expect(updates.phase).toBe('idle')
    expect(updates.error).toBe('')
  })
})
