import { clearMocks, mockIPC, mockWindows } from '@tauri-apps/api/mocks'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  applyWindowIntent,
  freshWindowUrl,
  installDesktopWindowBridge,
  intentFromLocation,
  publishDesktopMenusFromStorage,
  readStartupIntent,
  reportOpenProject,
  requestNewProject,
  requestNewWindow,
  requestOpenProject,
  type WindowHost,
} from './windows'

const calls: { cmd: string; args?: Record<string, unknown> }[] = []

function installTauri(reply?: (cmd: string) => unknown) {
  calls.length = 0
  mockWindows('main')
  mockIPC((cmd, args) => {
    calls.push({ cmd, args: args as Record<string, unknown> | undefined })
    return reply?.(cmd)
  }, { shouldMockEvents: true })
}

function commands(name: string) {
  return calls.filter((call) => call.cmd === name)
}

function setBrowser() {
  clearMocks()
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
}

function host(partial: Partial<WindowHost> = {}): WindowHost & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    phase: 'chooser',
    restoreOpened: vi.fn(async () => { calls.push('restore') }),
    openVaultPath: vi.fn(async (path: string) => { calls.push(`open:${path}`) }),
    openFromDraft: vi.fn(async () => { calls.push('pick-open') }),
    createNewVault: vi.fn(async () => { calls.push('pick-create') }),
    replaceRecentProjects: vi.fn(),
    ...partial,
  }
}

describe('window intents', () => {
  afterEach(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
    setBrowser()
    calls.length = 0
    window.history.replaceState(null, '', '/')
    localStorage.removeItem('stride:vaults')
    vi.restoreAllMocks()
  })

  it('reads the startup query and falls open-without-a-path back to a fresh window', () => {
    expect(intentFromLocation('http://127.0.0.1:1420/')).toBeNull()
    expect(intentFromLocation('http://127.0.0.1:1420/?window=fresh')).toEqual({ kind: 'fresh' })
    expect(intentFromLocation('http://127.0.0.1:1420/?window=pick-open')).toEqual({ kind: 'pick-open' })
    expect(intentFromLocation('http://127.0.0.1:1420/?window=pick-create')).toEqual({ kind: 'pick-create' })
    expect(intentFromLocation('http://127.0.0.1:1420/?window=open&vault=/Users/notes')).toEqual({
      kind: 'open',
      path: '/Users/notes',
    })
    expect(intentFromLocation('http://127.0.0.1:1420/?window=open')).toEqual({ kind: 'fresh' })
    expect(intentFromLocation('http://127.0.0.1:1420/?window=nope')).toEqual({ kind: 'restore' })
  })

  it('builds a fresh chooser url without fixture or vault params', () => {
    expect(freshWindowUrl('http://127.0.0.1:1420/?fixture=memory&seed=4&vault=/tmp&window=open')).toBe(
      'http://127.0.0.1:1420/?window=fresh',
    )
  })

  it('prefers the query over the host intent and restores when the host payload is invalid', async () => {
    window.history.replaceState(null, '', '/?window=fresh')
    installTauri(() => ({ kind: 'pick-open' }))
    await expect(readStartupIntent()).resolves.toEqual({ kind: 'fresh' })
    expect(commands('window_intent')).toHaveLength(0)

    window.history.replaceState(null, '', '/')
    installTauri((cmd) => (cmd === 'window_intent' ? { kind: 'open', path: '/Users/notes' } : null))
    await expect(readStartupIntent()).resolves.toEqual({ kind: 'open', path: '/Users/notes' })

    installTauri(() => ({ kind: 'later' }))
    await expect(readStartupIntent()).resolves.toEqual({ kind: 'restore' })
    installTauri(() => { throw new Error('missing') })
    await expect(readStartupIntent()).resolves.toEqual({ kind: 'restore' })
  })

  it('applies an intent once and reports an empty window only when it stays a chooser', async () => {
    installTauri()
    const ready = host()
    ready.openVaultPath = vi.fn(async () => {
      ready.phase = 'ready'
    })
    await applyWindowIntent(ready, { kind: 'open', path: '/Users/notes' })
    expect(ready.openVaultPath).toHaveBeenCalledWith('/Users/notes')
    expect(commands('window_set_project')).toHaveLength(0)

    const fresh = host()
    await applyWindowIntent(fresh, { kind: 'fresh' })
    expect(fresh.calls).toEqual([])
    await vi.waitFor(() => expect(commands('window_set_project')).toEqual([{ cmd: 'window_set_project', args: { path: null } }]))
    expect(commands('plugin:window|set_title')[0]?.args).toMatchObject({ value: 'Stride' })
  })

  it('opens a browser window for a fresh chooser and asks the host on the desktop', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    requestNewWindow()
    expect(open).toHaveBeenCalledWith(freshWindowUrl())

    installTauri()
    requestNewWindow()
    requestNewProject()
    requestOpenProject()
    await vi.waitFor(() => {
      expect(commands('menu_new_window')).toHaveLength(1)
      expect(commands('menu_new_project')).toHaveLength(1)
      expect(commands('menu_open_project')).toHaveLength(1)
    })
  })

  it('titles an open project from the folder name', async () => {
    installTauri()
    reportOpenProject('/Users/a/notes')
    await vi.waitFor(() => {
      expect(commands('window_set_project')).toEqual([{ cmd: 'window_set_project', args: { path: '/Users/a/notes' } }])
      expect(commands('plugin:window|set_title')[0]?.args).toMatchObject({ value: 'notes — Stride' })
    })
  })

  it('delivers a later intent to the running window and replaces the recent list', async () => {
    installTauri()
    const vault = host()
    installDesktopWindowBridge(vault)
    const { emit } = await import('@tauri-apps/api/event')
    await emit('stride://window-intent', { kind: 'pick-create' })
    await vi.waitFor(() => expect(vault.createNewVault).toHaveBeenCalled())
    await emit('stride://recent-replaced', [
      { id: 'v1', path: '/Users/notes', title: 'notes', lastOpened: '2026-01-01T00:00:00.000Z' },
    ])
    expect(vault.replaceRecentProjects).toHaveBeenCalledWith([
      { id: 'v1', path: '/Users/notes', title: 'notes', lastOpened: '2026-01-01T00:00:00.000Z' },
    ])
  })

  it('does not publish menus from a memory fixture or a browser', () => {
    publishDesktopMenusFromStorage()
    expect(calls).toHaveLength(0)
    installTauri()
    window.history.replaceState(null, '', '/?fixture=memory')
    localStorage.setItem('stride:vaults', JSON.stringify([
      { id: 'v1', label: '/Users/notes', color: '', icon: '', lastOpened: '2026-01-01T00:00:00.000Z' },
    ]))
    publishDesktopMenusFromStorage()
    expect(commands('sync_recent_projects')).toHaveLength(0)
  })
})
