import { pathToFileURL } from 'node:url'

/** Trust inputs shared by navigation guards and privileged IPC handlers. */
export type RendererTrust =
  | { packaged: true; appIndexPath: string; devUrl?: undefined }
  | { packaged: false; devUrl: string; appIndexPath?: undefined }

export interface NavigationGuardedWindow {
  webContents: {
    on(event: 'will-navigate' | 'will-redirect' | 'will-frame-navigate', listener: NavigationListener): void
  }
}

export interface TrustedSenderEvent {
  sender: { getURL(): string }
}

type NavigationListener = (event: { preventDefault(): void }, url: string, ...rest: unknown[]) => void

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname.toLowerCase())
}

/** Fail closed when a development URL is missing, non-http, or not loopback. */
export function assertTrustedDevUrl(devUrl: string): URL {
  let url: URL
  try {
    url = new URL(devUrl)
  } catch {
    throw new Error('STRIDE_DEV_URL is not a valid URL')
  }
  if (url.protocol !== 'http:') {
    throw new Error('STRIDE_DEV_URL must use http on a loopback host')
  }
  if (!isLoopbackHostname(url.hostname)) {
    throw new Error('STRIDE_DEV_URL must use http on a loopback host')
  }
  return url
}

export function resolveRendererTrust(input: {
  packaged: boolean
  devUrl?: string
  appIndexPath?: string
}): RendererTrust {
  if (input.packaged) {
    if (!input.appIndexPath) throw new Error('Packaged renderer index path is required')
    return { packaged: true, appIndexPath: input.appIndexPath }
  }
  if (!input.devUrl) throw new Error('STRIDE_DEV_URL is required in development')
  assertTrustedDevUrl(input.devUrl)
  return { packaged: false, devUrl: input.devUrl }
}

function trustedDevOrigin(devUrl: string | undefined): string | null {
  if (!devUrl) return null
  try {
    return assertTrustedDevUrl(devUrl).origin
  } catch {
    return null
  }
}

function sameFilePath(target: URL, indexPath: string): boolean {
  let indexUrl: URL
  try {
    indexUrl = pathToFileURL(indexPath)
  } catch {
    return false
  }
  try {
    return decodeURIComponent(target.pathname) === decodeURIComponent(indexUrl.pathname)
  } catch {
    return false
  }
}

/**
 * Development: http only, loopback host, origin equal to the configured dev URL.
 * Same-origin path changes are allowed. Packaged: only `dist/index.html` (query and hash ok).
 */
export function isTrustedRendererUrl(target: string, trust: RendererTrust): boolean {
  let url: URL
  try {
    url = new URL(target)
  } catch {
    return false
  }
  if (trust.packaged) {
    if (url.protocol !== 'file:') return false
    return sameFilePath(url, trust.appIndexPath)
  }
  if (url.protocol !== 'http:' || !isLoopbackHostname(url.hostname)) return false
  const origin = trustedDevOrigin(trust.devUrl)
  return origin !== null && url.origin === origin
}

export function installNavigationGuards(window: NavigationGuardedWindow, trust: RendererTrust): void {
  const contents = window.webContents
  const blockUntrusted: NavigationListener = (event, url) => {
    if (!isTrustedRendererUrl(url, trust)) event.preventDefault()
  }
  contents.on('will-navigate', blockUntrusted)
  contents.on('will-redirect', blockUntrusted)
  contents.on('will-frame-navigate', blockUntrusted)
}

/** Call before any IPC handler returns filesystem, git, shell, secrets, or window control. */
export function assertTrustedSender(event: TrustedSenderEvent, trust: RendererTrust): void {
  let current = ''
  try {
    current = event.sender.getURL()
  } catch {
    current = ''
  }
  if (!isTrustedRendererUrl(current, trust)) {
    throw new Error('Rejected IPC from an untrusted renderer')
  }
}
