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

const calls: { cmd: string; args?: unknown }[] = []
const listeners = new Map<string, Set<(payload: unknown) => void>>()

function installDesktop(reply?: (cmd: string, args?: unknown) => unknown) {
  calls.length = 0
  listeners.clear()
  ;(window as unknown as { __STRIDE_ELECTRON__?: unknown }).__STRIDE_ELECTRON__ = {
    invoke(channel: string, args?: unknown) {
      calls.push({ cmd: channel, args })
      try {
        return Promise.resolve(reply?.(channel, args))
      } catch (error) {
        return Promise.reject(error)
      }
    },
    on(channel: string, listener: (payload: unknown) => void) {
      let set = listeners.get(channel)
      if (!set) {
        set = new Set()
        listeners.set(channel, set)
      }
      set.add(listener)
      return () => {
        set.delete(listener)
      }
    },
  }
}

function emit(channel: string, payload: unknown) {
  for (const listener of listeners.get(channel) ?? []) listener(payload)
}

function commands(name: string) {
  return calls.filter((call) => call.cmd === name)
}

function setBrowser() {
  delete (window as unknown as { __STRIDE_ELECTRON__?: unknown }).__STRIDE_ELECTRON__
  listeners.clear()
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
    installDesktop(() => ({ kind: 'pick-open' }))
    await expect(readStartupIntent()).resolves.toEqual({ kind: 'fresh' })
    expect(commands('window:intent')).toHaveLength(0)

    window.history.replaceState(null, '', '/')
    installDesktop((cmd) => (cmd === 'window:intent' ? { kind: 'open', path: '/Users/notes' } : null))
    await expect(readStartupIntent()).resolves.toEqual({ kind: 'open', path: '/Users/notes' })

    installDesktop(() => ({ kind: 'later' }))
    await expect(readStartupIntent()).resolves.toEqual({ kind: 'restore' })
    installDesktop(() => { throw new Error('missing') })
    await expect(readStartupIntent()).resolves.toEqual({ kind: 'restore' })
  })

  it('applies an intent once and reports an empty window only when it stays a chooser', async () => {
    installDesktop()
    const ready = host()
    ready.openVaultPath = vi.fn(async () => {
      ready.phase = 'ready'
    })
    await applyWindowIntent(ready, { kind: 'open', path: '/Users/notes' })
    expect(ready.openVaultPath).toHaveBeenCalledWith('/Users/notes')
    expect(commands('window:setProject')).toHaveLength(0)

    const fresh = host()
    await applyWindowIntent(fresh, { kind: 'fresh' })
    expect(fresh.calls).toEqual([])
    await vi.waitFor(() => expect(commands('window:setProject')).toEqual([{ cmd: 'window:setProject', args: { path: null } }]))
  })

  it('opens a browser window for a fresh chooser and asks the host on the desktop', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    requestNewWindow()
    expect(open).toHaveBeenCalledWith(freshWindowUrl())

    installDesktop()
    requestNewWindow()
    requestNewProject()
    requestOpenProject()
    await vi.waitFor(() => {
      expect(commands('window:new')).toHaveLength(1)
      expect(commands('window:newProject')).toHaveLength(1)
      expect(commands('window:openProject')).toHaveLength(1)
    })
  })

  it('reports an open project path so the host can title the window', async () => {
    installDesktop()
    reportOpenProject('/Users/a/notes')
    await vi.waitFor(() => {
      expect(commands('window:setProject')).toEqual([{ cmd: 'window:setProject', args: { path: '/Users/a/notes' } }])
    })
  })

  it('delivers a later intent to the running window and replaces the recent list', async () => {
    installDesktop()
    const vault = host()
    installDesktopWindowBridge(vault)
    await vi.waitFor(() => expect(listeners.get('window:intent')?.size).toBe(1))
    emit('window:intent', { kind: 'pick-create' })
    await vi.waitFor(() => expect(vault.createNewVault).toHaveBeenCalled())
    emit('window:recent', [
      { id: 'v1', path: '/Users/notes', title: 'notes', lastOpened: '2026-01-01T00:00:00.000Z' },
    ])
    expect(vault.replaceRecentProjects).toHaveBeenCalledWith([
      { id: 'v1', path: '/Users/notes', title: 'notes', lastOpened: '2026-01-01T00:00:00.000Z' },
    ])
  })

  it('does not publish menus from a memory fixture or a browser', () => {
    publishDesktopMenusFromStorage()
    expect(calls).toHaveLength(0)
    installDesktop()
    window.history.replaceState(null, '', '/?fixture=memory')
    localStorage.setItem('stride:vaults', JSON.stringify([
      { id: 'v1', label: '/Users/notes', color: '', icon: '', lastOpened: '2026-01-01T00:00:00.000Z' },
    ]))
    publishDesktopMenusFromStorage()
    expect(commands('window:syncRecent')).toHaveLength(0)
  })
})
