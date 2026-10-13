import http from 'node:http'
import { once } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'
import { MemoryFileSystem } from '@stride/platform'
import { UpdateController, selectUpdate, type GithubRelease } from './updater.ts'
import { APP_VERSION } from './version.ts'

const servers: http.Server[] = []

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  for (let i = 0; i < left.byteLength; i += 1) if (left[i] !== right[i]) return false
  return true
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
})

describe('github release updater', () => {
  it('downloads only a newer asset and relaunches after confirm', async () => {
    const asset = new TextEncoder().encode('stride-update-bytes-v2')
    let assetUrl = ''
    const server = http.createServer((req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      if (url.pathname === '/releases') {
        const releases: GithubRelease[] = [
          {
            tag_name: 'v9.0.0',
            draft: true,
            assets: [{ name: 'draft.bin', browser_download_url: assetUrl }],
          },
          {
            tag_name: 'v0.0.1',
            draft: false,
            assets: [{ name: 'old.bin', browser_download_url: assetUrl }],
          },
          {
            tag_name: `v${APP_VERSION}`,
            draft: false,
            assets: [{ name: 'same.bin', browser_download_url: assetUrl }],
          },
          {
            tag_name: 'v0.2.0',
            draft: false,
            assets: [{ name: 'stride-0.2.0.bin', browser_download_url: assetUrl }],
          },
        ]
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(releases))
        return
      }
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': String(asset.length),
      })
      res.end(asset)
    })
    servers.push(server)
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('no port')
    assetUrl = `http://127.0.0.1:${address.port}/stride-0.2.0.bin`
    const releasesUrl = `http://127.0.0.1:${address.port}/releases`

    const root = '/virtual/stride-update'
    const files = new MemoryFileSystem(root)
    const marker = 'version-marker.txt'
    const installRel = 'installed/stride'
    const installPath = `${root}/${installRel}`
    await files.writeText(marker, `${APP_VERSION}\n`)
    let relaunchedAt = ''
    const updater = new UpdateController(files, APP_VERSION, fetch, async (installed) => {
      relaunchedAt = installed
      expect(sameBytes(await files.readBytes(installRel), asset)).toBe(true)
      expect((await files.readText(marker)).trim()).toBe('v0.2.0')
    }, { file: marker, installPath: installRel })

    const selected = await updater.check(releasesUrl)
    expect(selected?.version).toBe('v0.2.0')
    expect(selected?.assetName).toBe('stride-0.2.0.bin')
    expect(updater.phase).toBe('available')
    expect(relaunchedAt).toBe('')

    const onlyDraft = selectUpdate(
      [{ tag_name: 'v9.0.0', draft: true, assets: [{ name: 'draft.bin', browser_download_url: assetUrl }] }],
      APP_VERSION,
    )
    expect(onlyDraft).toBeNull()
    const same = selectUpdate(
      [{ tag_name: `v${APP_VERSION}`, draft: false, assets: [{ name: 'same.bin', browser_download_url: assetUrl }] }],
      APP_VERSION,
    )
    expect(same).toBeNull()

    const dest = 'stride-0.2.0.bin'
    await updater.download(dest)
    expect(updater.events.map((event) => event.event)).toEqual(['Started', 'Progress', 'Finished'])
    expect(sameBytes(await files.readBytes(dest), asset)).toBe(true)
    expect(updater.phase).toBe('ready')
    expect(updater.progress).toBe(1)
    expect(relaunchedAt).toBe('')
    expect((await files.readText(marker)).trim()).toBe(APP_VERSION)
    expect(await files.stat(installRel)).toBeNull()

    const beforeDismiss = await files.readText(marker)
    updater.dismiss()
    expect(updater.phase).toBe('idle')
    expect(await files.readText(marker)).toBe(beforeDismiss)
    expect(relaunchedAt).toBe('')

    await updater.check(releasesUrl)
    await updater.download(dest)
    await files.rename(dest, `${dest}.aside`)
    await expect(updater.confirm()).rejects.toThrow(/Downloaded update is missing/)
    expect((await files.readText(marker)).trim()).toBe(APP_VERSION)
    expect(relaunchedAt).toBe('')
    expect(await files.stat(installRel)).toBeNull()
    await files.rename(`${dest}.aside`, dest)
    await updater.confirm()
    expect(relaunchedAt).toBe(installPath)
    expect(sameBytes(await files.readBytes(installRel), asset)).toBe(true)
    expect((await files.readText(marker)).trim()).toBe('v0.2.0')
  })
})
