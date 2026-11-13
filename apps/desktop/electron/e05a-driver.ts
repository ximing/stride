import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { get } from 'node:http'
import { app, BrowserWindow, Menu } from 'electron'
import type { WindowHost } from './windows.ts'

export async function runE05aDriver(input: {
  host: WindowHost
  loadRenderer(window: BrowserWindow): Promise<void>
  userData: string
}): Promise<void> {
  const resultPath = process.env.STRIDE_E05A_RESULT
  if (!resultPath) throw new Error('STRIDE_E05A_RESULT is required')
  const first = await waitForWindow(input.host, 1)
  await waitForScript(first.window, 'window.__strideReady === true')

  input.host.deliver({ kind: 'fresh' })
  const pair = await waitForCount(input.host, 2)
  await pair[1]!.window.webContents.executeJavaScript('window.__strideReady === true')

  const alpha = '/tmp/stride-e05a-not-a-vault/alpha'
  const beta = '/tmp/stride-e05a-not-a-vault/beta'
  await invoke(pair[0]!.window, 'window:setProject', { path: alpha })
  await invoke(pair[1]!.window, 'window:setProject', { path: null })
  input.host.deliver({ kind: 'open', path: `${alpha}/` })
  const afterSame = input.host.records().filter((record) => !record.window.isDestroyed())
  const focusedId = input.host.records().find((record) => record.window.isFocused())?.id ?? null

  input.host.deliver({ kind: 'open', path: beta })
  const afterReuse = input.host.records().filter((record) => !record.window.isDestroyed())
  const empty = afterReuse.find((record) => record.openPath == null)
  const reusedIntent = empty
    ? await waitForScript(empty.window, 'window.__strideIntent')
    : null

  const projects = [
    { id: alpha, path: alpha, title: 'alpha', lastOpened: '2026-03-02T00:00:00.000Z' },
    { id: beta, path: `${beta}/`, title: '', lastOpened: '2026-03-01T00:00:00.000Z' },
    { id: '/tmp/stride-e05a-not-a-vault/gamma', path: '/tmp/stride-e05a-not-a-vault/gamma', title: 'gamma', lastOpened: '2026-03-03T00:00:00.000Z' },
  ]
  const copy = {
    file: 'File',
    newWindow: 'New Window',
    newProject: 'New Project…',
    openProject: 'Open Project…',
    openRecent: 'Open Recent',
    clearRecent: 'Clear Recently Opened',
    closeWindow: 'Close Window',
    emptyRecent: 'No Recent Projects',
  }
  await invoke(pair[0]!.window, 'window:syncRecent', { projects, copy })
  const menu = Menu.getApplicationMenu()
  const file = menu?.items.find((item) => item.id === 'file' || item.label === 'File')
  const recentMenu = file?.submenu?.items.find((item) => item.id === 'file.open-recent')
  const recentLabels = recentMenu?.submenu?.items.map((item) => item.label).filter(Boolean) ?? []
  input.host.clearRecent()
  const recentEvent = await waitForScript(pair[0]!.window, 'window.__strideRecent')

  const link = 'stride://focus?vault=/tmp/stride-e05a-not-a-vault/alpha'
  const childEnv = { ...process.env }
  delete childEnv.ELECTRON_RUN_AS_NODE
  const child = spawn(process.execPath, [process.argv[1] ?? '', link], {
    env: childEnv,
    detached: true,
    stdio: ['ignore', 'inherit', 'inherit'],
  })
  const childExit = await new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve(null)
    }, 8000)
    child.once('exit', (code) => {
      clearTimeout(timer)
      resolve(code)
    })
  })
  const seenLink = await waitForLink(input.host)

  let cdpTargets = 0
  if (process.env.STRIDE_CDP_PORT) {
    cdpTargets = await countCdpTargets(process.env.STRIDE_CDP_PORT)
  }

  const report = {
    freshCount: pair.length,
    afterSameOpen: afterSame.length,
    focusedId,
    afterReuse: afterReuse.length,
    reusedIntent,
    titles: afterReuse.map((record) => record.window.getTitle()),
    recentLabels,
    recentEvent,
    storedRecent: input.host.recent().map((project) => project.path),
    childExit,
    seenLink,
    cdpTargets,
    menuRoles: menu?.items.map((item) => item.label) ?? [],
  }
  writeFileSync(resultPath, JSON.stringify(report))
  app.exit(0)
}

function invoke(window: BrowserWindow, channel: string, payload?: unknown): Promise<unknown> {
  return window.webContents.executeJavaScript(
    `window.__STRIDE_ELECTRON__.invoke(${JSON.stringify(channel)}, ${JSON.stringify(payload ?? null)})`,
  )
}

async function waitForWindow(host: WindowHost, count: number) {
  const records = await waitForCount(host, count)
  return records[count - 1]!
}

async function waitForCount(host: WindowHost, count: number) {
  const start = Date.now()
  while (Date.now() - start < 15000) {
    const records = host.records().filter((record) => !record.window.isDestroyed())
    if (records.length >= count) return records
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`Timed out waiting for ${count} windows`)
}

async function waitForLink(host: WindowHost): Promise<unknown> {
  const start = Date.now()
  while (Date.now() - start < 10000) {
    for (const record of host.records()) {
      if (record.window.isDestroyed()) continue
      const value = await record.window.webContents.executeJavaScript('window.__strideLink')
      if (value) return value
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return null
}

async function waitForScript(window: BrowserWindow, expression: string): Promise<unknown> {
  const start = Date.now()
  while (Date.now() - start < 10000) {
    const value = await window.webContents.executeJavaScript(expression)
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return null
}

function countCdpTargets(port: string): Promise<number> {
  return new Promise((resolve) => {
    const request = get(`http://127.0.0.1:${port}/json`, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('end', () => {
        try {
          const targets = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown[]
          resolve(Array.isArray(targets) ? targets.length : 0)
        } catch {
          resolve(0)
        }
      })
    })
    request.on('error', () => resolve(0))
  })
}
