import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'
import { UpdateController, selectUpdate, type GithubRelease } from './updater.ts'
import { APP_VERSION } from './version.ts'

const dirs: string[] = []
const servers: http.Server[] = []

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stride-update-'))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('github release updater', () => {
  it('downloads only a newer asset and relaunches after confirm', async () => {
    const dir = tempDir()
    const asset = Buffer.from('stride-update-bytes-v2')
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

    const marker = path.join(dir, 'version-marker.txt')
    const installPath = path.join(dir, 'installed', 'stride')
    fs.writeFileSync(marker, `${APP_VERSION}\n`)
    let relaunchedAt = ''
    const updater = new UpdateController(APP_VERSION, fetch, (installed) => {
      relaunchedAt = installed
      expect(fs.readFileSync(installed).equals(asset)).toBe(true)
      expect(fs.readFileSync(marker, 'utf8').trim()).toBe('v0.2.0')
    }, { file: marker, installPath })

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

    const dest = path.join(dir, 'stride-0.2.0.bin')
    await updater.download(dest)
    expect(updater.events.map((event) => event.event)).toEqual(['Started', 'Progress', 'Finished'])
    expect(fs.readFileSync(dest).equals(asset)).toBe(true)
    expect(updater.phase).toBe('ready')
    expect(updater.progress).toBe(1)
    expect(relaunchedAt).toBe('')
    expect(fs.readFileSync(marker, 'utf8').trim()).toBe(APP_VERSION)
    expect(fs.existsSync(installPath)).toBe(false)

    const beforeDismiss = fs.readFileSync(marker, 'utf8')
    updater.dismiss()
    expect(updater.phase).toBe('idle')
    expect(fs.readFileSync(marker, 'utf8')).toBe(beforeDismiss)
    expect(relaunchedAt).toBe('')

    await updater.check(releasesUrl)
    await updater.download(dest)
    fs.renameSync(dest, `${dest}.aside`)
    await expect(updater.confirm()).rejects.toThrow(/Downloaded update is missing/)
    expect(fs.readFileSync(marker, 'utf8').trim()).toBe(APP_VERSION)
    expect(relaunchedAt).toBe('')
    expect(fs.existsSync(installPath)).toBe(false)
    fs.renameSync(`${dest}.aside`, dest)
    await updater.confirm()
    expect(relaunchedAt).toBe(installPath)
    expect(fs.readFileSync(installPath).equals(asset)).toBe(true)
    expect(fs.readFileSync(marker, 'utf8').trim()).toBe('v0.2.0')
  })
})
