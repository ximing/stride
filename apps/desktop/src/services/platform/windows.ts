import { t } from '../../i18n'
import {
  folderTitle,
  readStoredVaults,
  recentProjectsFromRecords,
  type RecentProject,
} from '../vault/vault-registry'
import { isMemoryFixture, isTauriRuntime } from './runtime'

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

async function tauriInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<T>(command, args)
}

export async function readStartupIntent(href = window.location.href): Promise<WindowIntent> {
  const fromLocation = intentFromLocation(href)
  if (fromLocation) return fromLocation
  if (!isTauriRuntime()) return { kind: 'restore' }
  try {
    return parseIntent(await tauriInvoke('window_intent')) ?? { kind: 'restore' }
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
  if (!isTauriRuntime()) return
  const title = path ? `${folderTitle(path)} — Stride` : 'Stride'
  void (async () => {
    try {
      await tauriInvoke('window_set_project', { path })
      const { getCurrentWindow } = await import('@tauri-apps/api/window')
      await getCurrentWindow().setTitle(title)
    } catch (error) {
      logWindow(error)
    }
  })()
}

export function requestNewWindow(): void {
  if (isTauriRuntime()) {
    void tauriInvoke('menu_new_window').catch(logWindow)
    return
  }
  window.open(freshWindowUrl())
}

export function requestNewProject(): void {
  if (!isTauriRuntime()) return
  void tauriInvoke('menu_new_project').catch(logWindow)
}

export function requestOpenProject(): void {
  if (!isTauriRuntime()) return
  void tauriInvoke('menu_open_project').catch(logWindow)
}

export function syncRecentProjects(projects: readonly RecentProject[]): void {
  if (!isTauriRuntime() || isMemoryFixture()) return
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
  void tauriInvoke('sync_recent_projects', { projects, copy }).catch(logWindow)
}

export function publishDesktopMenusFromStorage(): void {
  if (!isTauriRuntime() || isMemoryFixture()) return
  syncRecentProjects(recentProjectsFromRecords(readStoredVaults()))
}

export function installDesktopWindowBridge(vault: WindowHost): void {
  if (!isTauriRuntime()) return
  void import('@tauri-apps/api/event')
    .then(({ listen }) => Promise.all([
      listen<unknown>('stride://window-intent', (event) => {
        const intent = parseIntent(event.payload)
        if (intent) void applyWindowIntent(vault, intent)
      }),
      listen<unknown>('stride://recent-replaced', (event) => {
        if (isMemoryFixture() || !Array.isArray(event.payload)) return
        vault.replaceRecentProjects(event.payload.filter(isRecentProject))
      }),
    ]))
    .catch(logWindow)
}
