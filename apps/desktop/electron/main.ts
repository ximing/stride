import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell, type IpcMainInvokeEvent } from 'electron'
import packageJson from '../package.json'
import type { AppInfo } from '@stride/electron-api'
import { createDeepLinkQueue, handleOpenUrl, strideUrlsFromAdditional, strideUrlsFromArgv } from './deep-link.ts'
import { runE05aDriver } from './e05a-driver.ts'
import { installExternalWindowOpener, registerHostExternal } from './external-url.ts'
import { registerHostFonts } from './fonts.ts'
import { registerHostFs } from './fs.ts'
import { disposeHostFetches, registerHostFetch } from './host-fetch.ts'
import { registerHostGit } from './git.ts'
import { installApplicationMenu } from './menu.ts'
import { registerHostSecrets } from './secrets.ts'
import {
  assertTrustedSender,
  installNavigationGuards,
  resolveRendererTrust,
  type RendererTrust,
} from './security.ts'
import { disposeAllShellSessions, disposeShellSender, registerHostShell } from './shell.ts'
import { registerHostUpdater } from './updater.ts'
import { deliverDeepLink, registerWindowHost, type WindowHost } from './windows.ts'
import { WINDOW_STATE_FILE_NAME, userDataDirectoryName } from './window-state.ts'

app.setName('Stride')
const userDataOverride = process.env.STRIDE_USER_DATA
app.setPath(
  'userData',
  userDataOverride && userDataOverride.length > 0
    ? userDataOverride
    : join(app.getPath('appData'), userDataDirectoryName(app.isPackaged)),
)

if (process.env.STRIDE_CDP_PORT) {
  app.commandLine.appendSwitch('remote-debugging-port', process.env.STRIDE_CDP_PORT)
}

const deepLinks = createDeepLinkQueue()
const startupUrls = strideUrlsFromArgv(process.argv)
for (const url of startupUrls) deepLinks.push(url)

const hasSingleInstanceLock = app.requestSingleInstanceLock({ strideUrls: startupUrls })
app.on('open-url', (event, url) => {
  handleOpenUrl(hasSingleInstanceLock, url, () => event.preventDefault(), (next) => deepLinks.push(next))
})
if (!hasSingleInstanceLock) {
  console.error('Stride is already running; this process will exit without a window.')
  // The lock IPC is delivered inside requestSingleInstanceLock, then flushed on a later turn.
  setTimeout(() => app.exit(0), 200)
}

let host: WindowHost | null = null
if (hasSingleInstanceLock) startHost()

function startHost(): void {
  app.on('browser-window-created', (_event, window) => {
    installExternalWindowOpener(window, (url) => shell.openExternal(url))
  })

app.on('second-instance', (_event, argv, _workingDirectory, additionalData) => {
  const urls = [...strideUrlsFromArgv(argv), ...strideUrlsFromAdditional(additionalData)]
  for (const url of urls) deepLinks.push(url)
  if (!app.isReady() || !host) return
  host.focusAny()
})

function windowStatePath(): string {
  return join(app.getPath('userData'), WINDOW_STATE_FILE_NAME)
}

function rendererTrust(): RendererTrust {
  return resolveRendererTrust({
    packaged: app.isPackaged,
    devUrl: process.env.STRIDE_DEV_URL,
    appIndexPath: join(__dirname, '../dist/index.html'),
  })
}

function sendTo(window: BrowserWindow, channel: string, payload: unknown): void {
  if (window.isDestroyed() || window.webContents.isDestroyed()) return
  window.webContents.send(channel, payload)
}

function loadRenderer(window: BrowserWindow, trust: RendererTrust): Promise<void> {
  if (trust.packaged) return window.loadFile(trust.appIndexPath)
  return window.loadURL(trust.devUrl)
}

function focusedOrFirst(): BrowserWindow | null {
  const focused = BrowserWindow.getFocusedWindow()
  if (focused && !focused.isDestroyed()) return focused
  const live = host?.records().map((record) => record.window).filter((window) => !window.isDestroyed()) ?? []
  return live[0] ?? null
}

function ensureWindow(): BrowserWindow {
  const existing = focusedOrFirst()
  if (existing) return existing
  if (!host) throw new Error('Window host is not ready')
  const window = host.openInitial()
  void loadRenderer(window, rendererTrust())
  return window
}

function registerIpc(): void {
  ipcMain.handle('app:info', (event): AppInfo => {
    assertTrustedSender(event, rendererTrust())
    return {
      version: packageJson.version,
      platform: process.platform,
    }
  })

  registerHostFs({
    handle: (channel, listener) => {
      ipcMain.handle(channel, listener)
    },
    getTrust: rendererTrust,
    homedir: () => process.env.STRIDE_HOME || homedir(),
    showOpenDialog: (window, options) => dialog.showOpenDialog(window as BrowserWindow, options),
    windowFromSender: (sender) => BrowserWindow.fromWebContents(sender as IpcMainInvokeEvent['sender']),
  })

  registerHostGit({
    handle: (channel, listener) => {
      ipcMain.handle(channel, listener)
    },
    getTrust: rendererTrust,
  })

  registerHostSecrets({
    handle: (channel, listener) => {
      ipcMain.handle(channel, listener)
    },
    getTrust: rendererTrust,
    userDataPath: () => app.getPath('userData'),
    safeStorage,
  })

  registerHostShell({
    handle: (channel, listener) => {
      ipcMain.handle(channel, listener)
    },
    getTrust: rendererTrust,
  })

  registerHostFetch({
    handle: (channel, listener) => {
      ipcMain.handle(channel, listener)
    },
    getTrust: rendererTrust,
  })

  registerHostFonts({
    handle: (channel, listener) => {
      ipcMain.handle(channel, listener)
    },
    getTrust: rendererTrust,
  })

  registerHostUpdater({
    handle: (channel, listener) => {
      ipcMain.handle(channel, listener)
    },
    getTrust: rendererTrust,
    isPackaged: () => app.isPackaged,
    currentVersion: () => packageJson.version,
    relaunch: () => app.relaunch(),
    exit: (code) => app.exit(code),
  })

  registerHostExternal({
    handle: (channel, listener) => {
      ipcMain.handle(channel, listener)
    },
    getTrust: rendererTrust,
    openExternal: (url) => shell.openExternal(url),
    exit: (code) => app.exit(code),
    relaunch: () => app.relaunch(),
  })

  const menu = installApplicationMenu({
    deliver: (intent) => host?.deliver(intent),
    clearRecent: () => {
      host?.clearRecent()
    },
    closeFocused: () => {
      const window = focusedOrFirst()
      window?.close()
    },
    zoomFocused: () => {
      const window = focusedOrFirst()
      if (!window) return
      if (window.isMaximized()) window.unmaximize()
      else window.maximize()
    },
  })

  host = registerWindowHost({
    userDataPath: () => app.getPath('userData'),
    getTrust: rendererTrust,
    preloadPath: join(__dirname, 'preload.cjs'),
    readStateFile: () => {
      try {
        return readFileSync(windowStatePath(), 'utf8')
      } catch {
        return null
      }
    },
    writeStateFile: (text) => {
      const filePath = windowStatePath()
      mkdirSync(join(filePath, '..'), { recursive: true })
      writeFileSync(filePath, text, 'utf8')
    },
    createWindow: (options) => {
      const window = new BrowserWindow(options)
      void loadRenderer(window, rendererTrust())
      return window
    },
    getFocusedWindow: () => BrowserWindow.getFocusedWindow(),
    handle: (channel, listener) => {
      ipcMain.handle(channel, listener)
    },
    installGuards: (window, trust) => installNavigationGuards(window, trust),
    onNavigation: (window) => {
      window.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
        if (!isMainFrame || isInPlace) return
        disposeShellSender(window.webContents)
      })
    },
    applyMenu: (projects, copy) => menu.apply(projects, copy),
    broadcast: (channel, payload) => {
      for (const window of BrowserWindow.getAllWindows()) sendTo(window, channel, payload)
    },
    send: sendTo,
  })
}

function installProtocolClient(): void {
  if (process.env.STRIDE_E05A_DRIVER === '1') return
  try {
    if (process.defaultApp && process.argv[1]) {
      app.setAsDefaultProtocolClient('stride', process.execPath, [process.argv[1]])
    } else {
      app.setAsDefaultProtocolClient('stride')
    }
  } catch (error) {
    console.error('[deep-link] setAsDefaultProtocolClient failed', error)
  }
}

app.whenReady().then(() => {
  registerIpc()
  installProtocolClient()
  deepLinks.drain((url) => {
    deliverDeepLink(ensureWindow(), url, sendTo)
  })
  if (!host || host.records().length === 0) {
    const window = host?.openInitial()
    if (window) void loadRenderer(window, rendererTrust())
  }
  if (process.env.STRIDE_E05A_DRIVER === '1' && host) {
    void runE05aDriver({
      host,
      loadRenderer: (window) => loadRenderer(window, rendererTrust()),
      userData: app.getPath('userData'),
    }).catch((error: unknown) => {
      console.error('[e05a] driver failed', error)
      app.exit(1)
    })
  }
})

app.on('activate', () => {
  if (!app.isReady() || !host) return
  if (host.records().some((record) => !record.window.isDestroyed())) {
    host.focusAny()
    return
  }
  const window = host.openInitial()
  void loadRenderer(window, rendererTrust())
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  disposeAllShellSessions()
  disposeHostFetches()
})
}
