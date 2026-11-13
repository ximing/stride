import type { BrowserWindow, BrowserWindowConstructorOptions, IpcMainInvokeEvent } from 'electron'
import type { MenuCopy, RecentProject, WindowControlAction, WindowIntent, WindowStateSnapshot } from '@stride/electron-api'
import type { RendererTrust } from './security.ts'
import { assertTrustedSender } from './security.ts'
import {
  defaultMenuCopy,
  loadRecentFile,
  menuSignature,
  normalizePath,
  parseMenuCopy,
  parseRecentProjects,
  prepareRecent,
  projectWindowTitle,
  saveRecentFile,
} from './recent.ts'
import { planDelivery } from './windows-plan.ts'
import {
  captureWindowState,
  defaultWindowState,
  parseWindowState,
  serializeWindowState,
  type PersistedWindowState,
} from './window-state.ts'

const CASCADE_OFFSET = 28

export interface HostWindow {
  id: string
  window: BrowserWindow
  intent: WindowIntent | null
  reported: boolean
  openPath: string | null
}

export interface WindowHostDeps {
  userDataPath(): string
  getTrust(): RendererTrust
  preloadPath: string
  readStateFile(): string | null
  writeStateFile(text: string): void
  createWindow(options: BrowserWindowConstructorOptions): BrowserWindow
  getFocusedWindow(): BrowserWindow | null
  handle(channel: string, listener: (event: IpcMainInvokeEvent, payload?: unknown) => unknown): void
  installGuards(window: BrowserWindow, trust: RendererTrust): void
  onNavigation(window: BrowserWindow): void
  applyMenu(projects: RecentProject[], copy: MenuCopy): void
  broadcast(channel: string, payload: unknown): void
  send(window: BrowserWindow, channel: string, payload: unknown): void
}

export interface WindowHost {
  records(): HostWindow[]
  openInitial(): BrowserWindow
  deliver(intent: WindowIntent): void
  focusAny(): void
  syncRecent(projects: RecentProject[], copy: MenuCopy): void
  clearRecent(): RecentProject[]
  recent(): RecentProject[]
  copy(): MenuCopy
}

function snapshotOf(window: BrowserWindow): WindowStateSnapshot {
  return {
    maximized: window.isMaximized(),
    minimized: window.isMinimized(),
    fullscreen: window.isFullScreen(),
  }
}

function readControlAction(payload: unknown): WindowControlAction {
  if (typeof payload !== 'object' || payload === null || !('action' in payload)) {
    throw new Error('Rejected invalid window control action')
  }
  const action = payload.action
  if (action === 'close' || action === 'minimize' || action === 'toggleMaximize') return action
  throw new Error('Rejected invalid window control action')
}

function readProjectPath(payload: unknown): string | null {
  if (payload == null) return null
  if (typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Rejected invalid window project')
  }
  const path = (payload as { path?: unknown }).path
  if (path == null) return null
  if (typeof path !== 'string') throw new Error('Rejected invalid window project')
  return path === '' ? null : path
}

export function registerWindowHost(deps: WindowHostDeps): WindowHost {
  const records = new Map<string, HostWindow>()
  let nextId = 2
  let saveTimer: ReturnType<typeof setTimeout> | null = null
  let recent = loadRecentFile(deps.userDataPath())
  let copy = defaultMenuCopy()
  let signature = menuSignature(recent, copy)

  function loadState(): PersistedWindowState {
    const text = deps.readStateFile()
    if (text == null) return defaultWindowState()
    return parseWindowState(text)
  }

  function persistWindow(window: BrowserWindow): void {
    if (window.isDestroyed()) return
    const bounds = window.getNormalBounds()
    const state = captureWindowState(bounds, window.isMaximized())
    deps.writeStateFile(serializeWindowState(state))
  }

  function schedulePersist(window: BrowserWindow): void {
    if (saveTimer !== null) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      saveTimer = null
      persistWindow(window)
    }, 200)
  }

  function persistNow(window: BrowserWindow): void {
    if (saveTimer !== null) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
    persistWindow(window)
  }

  function publishWindowState(window: BrowserWindow): void {
    if (window.isDestroyed() || window.webContents.isDestroyed()) return
    deps.send(window, 'window:state', snapshotOf(window))
  }

  function senderRecord(event: IpcMainInvokeEvent): HostWindow {
    const found = [...records.values()].find((record) => record.window.webContents === event.sender)
    if (!found || found.window.isDestroyed()) throw new Error('Rejected window request for an unknown window')
    return found
  }

  function openPaths(): Map<string, string> {
    const paths = new Map<string, string>()
    for (const record of records.values()) {
      if (record.openPath) paths.set(record.id, record.openPath)
    }
    return paths
  }

  function reportedIds(): Set<string> {
    const ids = new Set<string>()
    for (const record of records.values()) {
      if (record.reported) ids.add(record.id)
    }
    return ids
  }

  function focusedId(): string | null {
    const focused = deps.getFocusedWindow()
    if (!focused) return null
    for (const record of records.values()) {
      if (record.window === focused) return record.id
    }
    return null
  }

  function focusRecord(record: HostWindow): void {
    const window = record.window
    if (window.isDestroyed()) return
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  }

  function sendWhenReady(window: BrowserWindow, channel: string, payload: unknown): void {
    const send = () => {
      if (window.isDestroyed() || window.webContents.isDestroyed()) return
      deps.send(window, channel, payload)
    }
    if (window.webContents.isLoading()) window.webContents.once('did-finish-load', send)
    else send()
  }

  function cascadeOrigin(): { x: number; y: number } | null {
    const focused = deps.getFocusedWindow()
    const window = focused && !focused.isDestroyed()
      ? focused
      : [...records.values()].find((record) => !record.window.isDestroyed())?.window
    if (!window) return null
    const bounds = window.getBounds()
    return { x: bounds.x + CASCADE_OFFSET, y: bounds.y + CASCADE_OFFSET }
  }

  function attach(record: HostWindow): void {
    const window = record.window
    const publish = () => publishWindowState(window)
    window.on('maximize', publish)
    window.on('unmaximize', publish)
    window.on('minimize', publish)
    window.on('restore', publish)
    window.on('enter-full-screen', publish)
    window.on('leave-full-screen', publish)
    window.on('resize', () => schedulePersist(window))
    window.on('close', () => persistNow(window))
    window.on('closed', () => {
      records.delete(record.id)
    })
    window.once('ready-to-show', () => {
      if (!window.isDestroyed()) window.show()
    })
    deps.installGuards(window, deps.getTrust())
    deps.onNavigation(window)
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  }

  function createWindow(intent: WindowIntent | null): BrowserWindow {
    const id = records.size === 0 ? 'main' : `win${nextId}`
    const state = loadState()
    const origin = records.size > 0 ? cascadeOrigin() : null
    let window: BrowserWindow
    try {
      window = deps.createWindow({
        width: state.width,
        height: state.height,
        x: origin?.x,
        y: origin?.y,
        resizable: true,
        frame: false,
        transparent: true,
        hasShadow: true,
        show: false,
        backgroundColor: '#00000000',
        title: 'Stride',
        webPreferences: {
          preload: deps.preloadPath,
          contextIsolation: true,
          nodeIntegration: false,
          nodeIntegrationInWorker: false,
          nodeIntegrationInSubFrames: false,
          sandbox: true,
          webSecurity: true,
        },
      })
    } catch (error) {
      throw error
    }
    const record: HostWindow = {
      id,
      window,
      intent,
      reported: false,
      openPath: null,
    }
    records.set(id, record)
    if (id !== 'main') nextId += 1
    if (state.maximized) window.maximize()
    attach(record)
    return window
  }

  function deliver(intent: WindowIntent): void {
    if (intent.kind === 'restore') return
    const decision = planDelivery(intent, openPaths(), reportedIds(), focusedId())
    if (decision.type === 'focus') {
      const record = records.get(decision.id)
      if (record) focusRecord(record)
      return
    }
    if (decision.type === 'emit') {
      const record = records.get(decision.id)
      if (!record || record.window.isDestroyed()) {
        createWindow(intent)
        return
      }
      record.intent = intent
      sendWhenReady(record.window, 'window:intent', intent)
      focusRecord(record)
      return
    }
    createWindow(intent)
  }

  function refreshMenu(): void {
    deps.applyMenu(recent, copy)
  }

  function syncRecent(projects: RecentProject[], nextCopy: MenuCopy): void {
    const normalized = prepareRecent(projects)
    const nextSignature = menuSignature(normalized, nextCopy)
    if (nextSignature === signature) return
    recent = normalized
    copy = nextCopy
    signature = nextSignature
    saveRecentFile(deps.userDataPath(), recent)
    refreshMenu()
  }

  function clearRecent(): RecentProject[] {
    const open = new Set([...openPaths().values()])
    recent = recent.filter((project) => open.has(normalizePath(project.path)))
    signature = menuSignature(recent, copy)
    saveRecentFile(deps.userDataPath(), recent)
    refreshMenu()
    deps.broadcast('window:recent', recent)
    return recent
  }

  deps.handle('window:control', (event, payload) => {
    assertTrustedSender(event, deps.getTrust())
    const action = readControlAction(payload)
    const window = senderRecord(event).window
    if (action === 'close') {
      window.close()
      return
    }
    if (action === 'minimize') {
      window.minimize()
      return
    }
    if (window.isMaximized()) window.unmaximize()
    else window.maximize()
  })

  deps.handle('window:state', (event) => {
    assertTrustedSender(event, deps.getTrust())
    return snapshotOf(senderRecord(event).window)
  })

  deps.handle('window:intent', (event) => {
    assertTrustedSender(event, deps.getTrust())
    const record = senderRecord(event)
    const intent = record.intent ?? { kind: 'restore' as const }
    record.intent = null
    return intent
  })

  deps.handle('window:setProject', (event, payload) => {
    assertTrustedSender(event, deps.getTrust())
    const record = senderRecord(event)
    const path = readProjectPath(payload)
    record.reported = true
    record.openPath = path ? normalizePath(path) : null
    record.window.setTitle(projectWindowTitle(record.openPath))
  })

  deps.handle('window:new', (event) => {
    assertTrustedSender(event, deps.getTrust())
    senderRecord(event)
    deliver({ kind: 'fresh' })
  })

  deps.handle('window:newProject', (event) => {
    assertTrustedSender(event, deps.getTrust())
    senderRecord(event)
    deliver({ kind: 'pick-create' })
  })

  deps.handle('window:openProject', (event) => {
    assertTrustedSender(event, deps.getTrust())
    senderRecord(event)
    deliver({ kind: 'pick-open' })
  })

  deps.handle('window:syncRecent', (event, payload) => {
    assertTrustedSender(event, deps.getTrust())
    senderRecord(event)
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('Rejected invalid recent projects')
    }
    const body = payload as { projects?: unknown; copy?: unknown }
    const projects = parseRecentProjects(body.projects)
    const nextCopy = parseMenuCopy(body.copy)
    syncRecent(projects, nextCopy)
  })

  refreshMenu()

  return {
    records() {
      return [...records.values()]
    },
    openInitial() {
      return createWindow(null)
    },
    deliver,
    focusAny() {
      const focused = focusedId()
      const record = (focused && records.get(focused)) || records.values().next().value
      if (record) focusRecord(record)
    },
    syncRecent,
    clearRecent,
    recent() {
      return recent
    },
    copy() {
      return copy
    },
  }
}

export function deliverDeepLink(window: BrowserWindow | null, url: string, send: WindowHostDeps['send']): void {
  if (!window || window.isDestroyed()) return
  const emit = () => {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) send(window, 'deep-link:open', { url })
  }
  if (window.webContents.isLoading()) window.webContents.once('did-finish-load', emit)
  else emit()
}
