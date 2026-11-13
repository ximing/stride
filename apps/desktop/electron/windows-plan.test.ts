import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import type { MenuCopy, RecentProject } from '@stride/electron-api'
import { defaultMenuCopy } from './recent.ts'
import { registerWindowHost, type WindowHostDeps } from './windows.ts'
import { planDelivery } from './windows-plan.ts'

function paths(pairs: Array<[string, string]>): Map<string, string> {
  return new Map(pairs)
}

describe('window delivery plan', () => {
  it('focuses a window that already has the vault', () => {
    const open = paths([['main', '/vaults/notes'], ['win2', '/vaults/other']])
    const known = new Set(['main', 'win2'])
    expect(planDelivery({ kind: 'open', path: '/vaults/notes/' }, open, known, 'win2')).toEqual({
      type: 'focus',
      id: 'main',
    })
    expect(planDelivery({ kind: 'open', path: '/vaults/other' }, open, known, 'main')).toEqual({
      type: 'focus',
      id: 'win2',
    })
  })

  it('reuses a reported empty window and prefers the focused one', () => {
    const open = paths([['main', '/vaults/notes']])
    expect(planDelivery(
      { kind: 'open', path: '/vaults/fresh' },
      open,
      new Set(['main', 'win2', 'win3']),
      'win3',
    )).toEqual({ type: 'emit', id: 'win3' })
    expect(planDelivery(
      { kind: 'pick-create' },
      open,
      new Set(['main', 'win2']),
      'main',
    )).toEqual({ type: 'emit', id: 'win2' })
  })

  it('always creates a fresh window and skips a busy unreported window', () => {
    const open = paths([['main', '/vaults/notes']])
    const known = new Set(['main'])
    expect(planDelivery({ kind: 'fresh' }, open, known, 'main')).toEqual({ type: 'create' })
    expect(planDelivery({ kind: 'pick-open' }, open, known, 'main')).toEqual({ type: 'create' })
    expect(planDelivery(
      { kind: 'open', path: '/vaults/other' },
      open,
      new Set(),
      'chooser',
    )).toEqual({ type: 'create' })
    expect(planDelivery({ kind: 'restore' }, open, known, 'main')).toEqual({ type: 'create' })
  })
})

const DEV = 'http://127.0.0.1:1421/'

interface FakeWindow {
  id: number
  destroyed: boolean
  title: string
  events: Array<{ channel: string; payload: unknown }>
  webContents: {
    isDestroyed(): boolean
    isLoading(): boolean
    once(): void
    setWindowOpenHandler(): void
  }
  isDestroyed(): boolean
  isMaximized(): boolean
  isMinimized(): boolean
  isFullScreen(): boolean
  isFocused(): boolean
  getNormalBounds(): { width: number; height: number; x: number; y: number }
  getBounds(): { width: number; height: number; x: number; y: number }
  maximize(): void
  restore(): void
  show(): void
  focus(): void
  close(): void
  minimize(): void
  unmaximize(): void
  setTitle(title: string): void
  on(): void
  once(): void
}

function fakeWindow(id: number): FakeWindow {
  const window: FakeWindow = {
    id,
    destroyed: false,
    title: 'Stride',
    events: [],
    webContents: {
      isDestroyed: () => false,
      isLoading: () => false,
      once: () => undefined,
      setWindowOpenHandler: () => undefined,
    },
    isDestroyed: () => window.destroyed,
    isMaximized: () => false,
    isMinimized: () => false,
    isFullScreen: () => false,
    isFocused: () => false,
    getNormalBounds: () => ({ width: 800, height: 600, x: 0, y: 0 }),
    getBounds: () => ({ width: 800, height: 600, x: 0, y: 0 }),
    maximize: () => undefined,
    restore: () => undefined,
    show: () => undefined,
    focus: () => undefined,
    close: () => undefined,
    minimize: () => undefined,
    unmaximize: () => undefined,
    setTitle: (title: string) => {
      window.title = title
    },
    on: () => undefined,
    once: () => undefined,
  }
  return window
}

describe('window intent consumption', () => {
  let root = ''
  const roots: string[] = []

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  async function host() {
    root = await mkdtemp(join(tmpdir(), 'stride-e05a-intent-'))
    roots.push(root)
    const handlers = new Map<string, (event: IpcMainInvokeEvent, payload?: unknown) => unknown>()
    const sent: Array<{ window: FakeWindow; channel: string; payload: unknown }> = []
    const menus: string[] = []
    let focused: FakeWindow | null = null
    let seq = 0
    const windows: FakeWindow[] = []
    const deps: WindowHostDeps = {
      userDataPath: () => root,
      getTrust: () => ({ packaged: false, devUrl: DEV }),
      preloadPath: 'preload.cjs',
      readStateFile: () => null,
      writeStateFile: () => undefined,
      createWindow: () => {
        const window = fakeWindow(seq)
        seq += 1
        windows.push(window)
        return window as unknown as BrowserWindow
      },
      getFocusedWindow: () => focused as unknown as BrowserWindow | null,
      handle: (channel, listener) => {
        handlers.set(channel, listener)
      },
      installGuards: () => undefined,
      onNavigation: () => undefined,
      applyMenu: (_projects, copy) => {
        menus.push(copy.file)
      },
      broadcast: () => undefined,
      send: (window, channel, payload) => {
        const fake = window as unknown as FakeWindow
        fake.events.push({ channel, payload })
        sent.push({ window: fake, channel, payload })
      },
    }
    const created = registerWindowHost(deps)
    function invoke(window: FakeWindow, channel: string, payload?: unknown) {
      const handler = handlers.get(channel)
      if (!handler) throw new Error(`missing ${channel}`)
      const sender = Object.assign(window.webContents, { getURL: () => DEV })
      return handler({ sender } as unknown as IpcMainInvokeEvent, payload)
    }
    return { created, invoke, windows, sent, menus, focus: (window: FakeWindow | null) => {
      focused = window
    } }
  }

  it('returns a fresh intent once, then restore', async () => {
    const { created, invoke, windows } = await host()
    created.deliver({ kind: 'fresh' })
    const window = windows[0]!
    expect(invoke(window, 'window:intent')).toEqual({ kind: 'fresh' })
    expect(invoke(window, 'window:intent')).toEqual({ kind: 'restore' })
    expect(window.events.filter((event) => event.channel === 'window:intent')).toEqual([])
  })

  it('keeps an emitted open or pick intent for one invoke and still notifies the page', async () => {
    const { created, invoke, windows, sent, focus } = await host()
    created.openInitial()
    const main = windows[0]!
    invoke(main, 'window:setProject', { path: '/tmp/stride-e05a-not-a-vault/alpha' })
    created.deliver({ kind: 'fresh' })
    const empty = windows[1]!
    invoke(empty, 'window:setProject', { path: null })
    focus(empty)
    created.deliver({ kind: 'open', path: '/tmp/stride-e05a-not-a-vault/beta' })
    expect(windows).toHaveLength(2)
    expect(sent.filter((event) => event.window === empty && event.channel === 'window:intent')).toEqual([
      { window: empty, channel: 'window:intent', payload: { kind: 'open', path: '/tmp/stride-e05a-not-a-vault/beta' } },
    ])
    expect(invoke(empty, 'window:intent')).toEqual({ kind: 'open', path: '/tmp/stride-e05a-not-a-vault/beta' })
    expect(invoke(empty, 'window:intent')).toEqual({ kind: 'restore' })
    created.deliver({ kind: 'pick-open' })
    expect(invoke(empty, 'window:intent')).toEqual({ kind: 'pick-open' })
    expect(sent.filter((event) => event.channel === 'window:intent').map((event) => event.payload)).toEqual([
      { kind: 'open', path: '/tmp/stride-e05a-not-a-vault/beta' },
      { kind: 'pick-open' },
    ])
  })

  it('rewrites recent storage when only lastOpened changes', async () => {
    const { created, invoke, windows, menus } = await host()
    created.openInitial()
    const main = windows[0]!
    const copy: MenuCopy = defaultMenuCopy()
    const project: RecentProject = {
      id: 'alpha',
      path: '/tmp/stride-e05a-not-a-vault/alpha',
      title: 'alpha',
      lastOpened: '2026-04-01T00:00:00.000Z',
    }
    invoke(main, 'window:syncRecent', { projects: [project], copy })
    const before = menus.length
    const later = { ...project, lastOpened: '2026-05-01T00:00:00.000Z' }
    invoke(main, 'window:syncRecent', { projects: [later], copy })
    expect(menus.length).toBe(before + 1)
    expect(await readFile(join(root, 'recent-projects.json'), 'utf8')).toContain('2026-05-01T00:00:00.000Z')
  })
})
