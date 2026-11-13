import { t } from '../../i18n'
import {
  readStoredVaults,
  recentProjectsFromRecords,
  type RecentProject,
} from '../vault/vault-registry'
import { isDesktopRuntime, isMemoryFixture } from './runtime'

export type WindowIntent =
  | { kind: 'restore' }
  | { kind: 'fresh' }
  | { kind: 'open'; path: string }
  | { kind: 'pick-open' }
  | { kind: 'pick-create' }

/** Narrow vault surface so this module does not import VaultService. */
export interface WindowHost {
  phase: string
  restoreOpened(): Promise<void>
  openVaultPath(path: string): Promise<void>
  openFromDraft(): Promise<void>
  createNewVault(): Promise<void>
  replaceRecentProjects(projects: RecentProject[]): void
}

function logWindow(error: unknown) {
  console.error('[window]', error)
}

export function intentFromLocation(href: string): WindowIntent | null {
  let url: URL
  try {
    url = new URL(href)
  } catch {
    return null
  }
  if (!url.searchParams.has('window')) return null
  const value = url.searchParams.get('window')
  if (value === 'fresh') return { kind: 'fresh' }
  if (value === 'pick-open') return { kind: 'pick-open' }
  if (value === 'pick-create') return { kind: 'pick-create' }
  if (value === 'open') {
    const path = url.searchParams.get('vault') ?? ''
    return path ? { kind: 'open', path } : { kind: 'fresh' }
  }
  return { kind: 'restore' }
}

export function freshWindowUrl(href = window.location.href): string {
  const url = new URL(href)
  url.searchParams.set('window', 'fresh')
  url.searchParams.delete('vault')
  url.searchParams.delete('fixture')
  url.searchParams.delete('seed')
  return url.toString()
}

function parseIntent(value: unknown): WindowIntent | null {
  if (!value || typeof value !== 'object') return null
  const kind = (value as { kind?: unknown }).kind
  if (kind === 'restore') return { kind: 'restore' }
  if (kind === 'fresh') return { kind: 'fresh' }
  if (kind === 'pick-open') return { kind: 'pick-open' }
  if (kind === 'pick-create') return { kind: 'pick-create' }
  if (kind === 'open') {
    const path = (value as { path?: unknown }).path
    return typeof path === 'string' && path !== '' ? { kind: 'open', path } : { kind: 'fresh' }
  }
  return null
}

function isRecentProject(value: unknown): value is RecentProject {
  if (!value || typeof value !== 'object') return false
  const project = value as Partial<RecentProject>
  return typeof project.id === 'string'
    && typeof project.path === 'string'
    && typeof project.title === 'string'
    && typeof project.lastOpened === 'string'
}

async function desktopInvoke<T>(channel: 'window:intent' | 'window:setProject' | 'window:new' | 'window:newProject' | 'window:openProject' | 'window:syncRecent', args?: unknown): Promise<T> {
  const { electronBridge } = await import('@stride/electron-api')
  return electronBridge().invoke<T>(channel, args)
}

export async function readStartupIntent(href = window.location.href): Promise<WindowIntent> {
  const fromLocation = intentFromLocation(href)
  if (fromLocation) return fromLocation
  if (!isDesktopRuntime()) return { kind: 'restore' }
  try {
    return parseIntent(await desktopInvoke('window:intent')) ?? { kind: 'restore' }
  } catch {
    return { kind: 'restore' }
  }
}

export async function applyWindowIntent(vault: WindowHost, intent: WindowIntent): Promise<void> {
  try {
    if (intent.kind === 'restore') await vault.restoreOpened()
    else if (intent.kind === 'open') await vault.openVaultPath(intent.path)
    else if (intent.kind === 'pick-open') await vault.openFromDraft()
    else if (intent.kind === 'pick-create') await vault.createNewVault()
  } finally {
    if (vault.phase !== 'ready') reportOpenProject(null)
  }
}

export function reportOpenProject(path: string | null): void {
  if (!isDesktopRuntime()) return
  // `window:setProject` also sets the native title from the folder name.
  void desktopInvoke('window:setProject', { path }).catch(logWindow)
}

export function requestNewWindow(): void {
  if (isDesktopRuntime()) {
    void desktopInvoke('window:new').catch(logWindow)
    return
  }
  window.open(freshWindowUrl())
}

export function requestNewProject(): void {
  if (!isDesktopRuntime()) return
  void desktopInvoke('window:newProject').catch(logWindow)
}

export function requestOpenProject(): void {
  if (!isDesktopRuntime()) return
  void desktopInvoke('window:openProject').catch(logWindow)
}

export function syncRecentProjects(projects: readonly RecentProject[]): void {
  if (!isDesktopRuntime() || isMemoryFixture()) return
  const copy = {
    file: t('menu.file'),
    newWindow: t('menu.newWindow'),
    newProject: t('menu.newProject'),
    openProject: t('menu.openProject'),
    openRecent: t('menu.openRecent'),
    clearRecent: t('menu.clearRecent'),
    closeWindow: t('menu.closeWindow'),
    emptyRecent: t('menu.emptyRecent'),
  }
  void desktopInvoke('window:syncRecent', { projects: [...projects], copy }).catch(logWindow)
}

export function publishDesktopMenusFromStorage(): void {
  if (!isDesktopRuntime() || isMemoryFixture()) return
  syncRecentProjects(recentProjectsFromRecords(readStoredVaults()))
}

/** Subscribe to later window intents and recent-list replacements. Safe to dispose more than once. */
export function installDesktopWindowBridge(vault: WindowHost): () => void {
  if (!isDesktopRuntime()) return () => {}
  let disposed = false
  const stops: Array<() => void> = []
  const stop = () => {
    if (disposed) return
    disposed = true
    for (const dispose of stops.splice(0)) dispose()
  }
  void import('@stride/electron-api')
    .then(({ electronBridge }) => {
      if (disposed) return
      const ipc = electronBridge()
      stops.push(ipc.on('window:intent', (payload) => {
        const intent = parseIntent(payload)
        if (intent) void applyWindowIntent(vault, intent)
      }))
      stops.push(ipc.on('window:recent', (payload) => {
        if (isMemoryFixture() || !Array.isArray(payload)) return
        vault.replaceRecentProjects(payload.filter(isRecentProject))
      }))
      if (disposed) {
        for (const dispose of stops.splice(0)) dispose()
      }
    })
    .catch((error: unknown) => {
      if (!disposed) logWindow(error)
    })
  return stop
}
