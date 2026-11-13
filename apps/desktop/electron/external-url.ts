import { assertTrustedSender, type RendererTrust, type TrustedSenderEvent } from './security.ts'

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

function parsed(value: string): URL | null {
  try {
    return new URL(value)
  } catch {
    return null
  }
}

function hasCredentials(url: URL): boolean {
  return url.username.length > 0 || url.password.length > 0
}

/** https anywhere, and http only on loopback. */
export function isAllowedFetchUrl(value: string): boolean {
  const url = parsed(value)
  if (!url || hasCredentials(url)) return false
  if (url.protocol === 'https:') return true
  if (url.protocol !== 'http:') return false
  return LOOPBACK_HOSTS.has(url.hostname.toLowerCase())
}

/** Any http(s) URL. Used for external links and the update page. */
export function isAllowedExternalUrl(value: string): boolean {
  const url = parsed(value)
  if (!url || hasCredentials(url)) return false
  return url.protocol === 'https:' || url.protocol === 'http:'
}

export interface ExternalOpenDetails {
  url: string
}

export interface ExternalOpenDecision {
  action: 'deny'
}

/** Open http(s) outside the app, then refuse an embedded window for every scheme. */
export function externalWindowOpenHandler(
  openExternal: (url: string) => void | Promise<void>,
): (details: ExternalOpenDetails) => ExternalOpenDecision {
  return (details) => {
    if (isAllowedExternalUrl(details.url)) {
      void Promise.resolve(openExternal(details.url)).catch(() => {})
    }
    return { action: 'deny' }
  }
}

export interface ExternalOpenWindow {
  isDestroyed(): boolean
  webContents: {
    setWindowOpenHandler(handler: (details: ExternalOpenDetails) => ExternalOpenDecision): void
  }
}

/**
 * `windows.ts` installs a deny-all handler while the window is constructed.
 * Replacing it on the next microtask keeps that file unchanged and still
 * opens http(s) targets outside the webview.
 */
export function installExternalWindowOpener(
  window: ExternalOpenWindow,
  openExternal: (url: string) => void | Promise<void>,
): void {
  queueMicrotask(() => {
    if (window.isDestroyed()) return
    window.webContents.setWindowOpenHandler(externalWindowOpenHandler(openExternal))
  })
}

export interface HostExternalEvent {
  sender: { getURL(): string }
}

export interface HostExternalDeps {
  handle(channel: string, listener: (event: HostExternalEvent, payload?: unknown) => unknown): void
  getTrust(): RendererTrust
  openExternal(url: string): Promise<void>
  exit(code: number): void
  relaunch(): void
}

function readUrl(payload: unknown): string {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error('Rejected external URL')
  }
  const url = (payload as { url?: unknown }).url
  if (typeof url !== 'string' || !isAllowedExternalUrl(url)) throw new Error('Rejected external URL')
  return url
}

export function registerHostExternal(deps: HostExternalDeps): void {
  deps.handle('host:openExternal', async (event, payload) => {
    assertTrustedSender(event as TrustedSenderEvent, deps.getTrust())
    await deps.openExternal(readUrl(payload))
  })

  deps.handle('app:exit', (event) => {
    assertTrustedSender(event as TrustedSenderEvent, deps.getTrust())
    deps.exit(0)
  })

  deps.handle('app:relaunch', (event) => {
    assertTrustedSender(event as TrustedSenderEvent, deps.getTrust())
    deps.relaunch()
    deps.exit(0)
  })
}
