import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)

const PAGE = `<!doctype html>
<meta charset="utf-8">
<title>stride-e05a</title>
<script>
window.__strideReady = false
window.__strideIntent = null
window.__strideRecent = null
window.__strideLink = null
const bridge = window.__STRIDE_ELECTRON__
bridge.on('window:intent', (payload) => { window.__strideIntent = payload })
bridge.on('window:recent', (payload) => { window.__strideRecent = payload })
bridge.on('deep-link:open', (payload) => { window.__strideLink = payload })
window.__strideReady = true
</script>`

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      if (!address || typeof address === 'string') {
        reject(new Error('missing port'))
        return
      }
      const { port } = address
      probe.close(() => resolve(port))
    })
  })
}

describe('electron window host', () => {
  it('opens two windows, reuses an empty one, persists recent projects, and delivers a deep link', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stride-e05a-'))
    const resultPath = join(root, 'result.json')
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(PAGE)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing port')
    const devUrl = `http://127.0.0.1:${address.port}/`
    const electron = require('electron') as string
    const main = join(import.meta.dirname, '../electron-dist/main.cjs')
    const cdp = await freePort()
    const child = spawn(electron, [main], {
      env: {
        ...process.env,
        STRIDE_DEV_URL: devUrl,
        STRIDE_USER_DATA: root,
        STRIDE_E05A_DRIVER: '1',
        STRIDE_E05A_RESULT: resultPath,
        STRIDE_CDP_PORT: String(cdp),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    const exit = await new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGTERM')
        resolve(null)
      }, 45000)
      child.once('exit', (code) => {
        clearTimeout(timer)
        resolve(code)
      })
    })
    server.close()
    try {
      const report = JSON.parse(await readFile(resultPath, 'utf8')) as {
        freshCount: number
        afterSameOpen: number
        afterReuse: number
        reusedIntent: { kind?: string; path?: string } | null
        recentLabels: string[]
        recentEvent: Array<{ path: string }>
        storedRecent: string[]
        childExit: number | null
        seenLink: { url?: string } | null
        cdpTargets: number
        menuRoles: string[]
        titles: string[]
      }
      expect(exit).toBe(0)
      expect(report.freshCount).toBe(2)
      expect(report.afterSameOpen).toBe(2)
      expect(report.afterReuse).toBe(2)
      expect(report.reusedIntent).toMatchObject({ kind: 'open', path: '/tmp/stride-e05a-not-a-vault/beta' })
      expect(report.recentLabels).toEqual(expect.arrayContaining(['gamma', 'alpha', 'beta']))
      expect(report.storedRecent).toEqual(['/tmp/stride-e05a-not-a-vault/alpha'])
      expect(report.recentEvent.map((item) => item.path)).toEqual(['/tmp/stride-e05a-not-a-vault/alpha'])
      expect(report.seenLink).toMatchObject({ url: 'stride://focus?vault=/tmp/stride-e05a-not-a-vault/alpha' })
      expect(report.childExit).toBe(0)
      expect(report.menuRoles).toEqual(expect.arrayContaining(['Stride', 'File', 'Edit', 'View', 'Window', 'Help']))
      expect(report.titles).toContain('alpha — Stride')
      expect(report.cdpTargets).toBeGreaterThanOrEqual(2)
    } catch (error) {
      throw new Error(`electron smoke exit=${exit} stderr=${stderr}\n${error instanceof Error ? error.stack : String(error)}`)
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL')
      await rm(root, { recursive: true, force: true })
    }
  }, 60000)
})
