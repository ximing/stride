import { raw } from '@rabjs/react'
import { isNoteFileName } from '@stride/core'
import { MemoryFileSystem, type FileSystemBackend, type WatchEvent } from '@stride/platform'
import type { VaultService } from './vault.service'

const REFRESH_DEBOUNCE_MS = 300

export interface VaultRefreshHandlers {
  full: () => void
  paths: (paths: string[]) => void
}

interface RefreshBinding {
  vault: object
  session: number
  watchGeneration: number
  stopWatch: (() => void) | null
  timer: ReturnType<typeof setTimeout> | null
  pending: { full: boolean; paths: Set<string> } | null
  onFocus: () => void
  onVisibility: () => void
  handlers: VaultRefreshHandlers
}

let current: RefreshBinding | null = null

/** OS watch is for real vault directories. Memory fixtures and broad personal roots stay on focus refresh. */
export function shouldAttachDiskWatch(fs: FileSystemBackend, broad: boolean): boolean {
  // `vault.fs` is a reactive proxy, so unwrap before the class check.
  const backend = raw(fs) as FileSystemBackend
  return backend.capabilities.watch && !(backend instanceof MemoryFileSystem) && !broad
}

/** Dot paths and node_modules are not note-tree changes. An empty path is the vault root. */
export function ignoredWatchPath(path: string): boolean {
  if (!path) return false
  return path.split('/').some((segment) => segment.startsWith('.') || segment === 'node_modules')
}

/**
 * Note files refresh incrementally. A directory, a missing non-note path, or
 * the vault root itself needs a full walk. Existing attachments are ignored.
 */
export async function classifyWatchedPaths(
  fs: FileSystemBackend,
  paths: readonly string[],
): Promise<'full' | string[]> {
  const notes: string[] = []
  for (const path of paths) {
    if (ignoredWatchPath(path)) continue
    if (!path) return 'full'
    const base = path.slice(path.lastIndexOf('/') + 1)
    if (isNoteFileName(base)) {
      notes.push(path)
      continue
    }
    const info = await fs.stat(path)
    if (info?.kind === 'file') continue
    return 'full'
  }
  return notes
}

function clearTimer(binding: RefreshBinding) {
  if (!binding.timer) return
  clearTimeout(binding.timer)
  binding.timer = null
}

function unbindCurrent() {
  const binding = current
  if (!binding) return
  current = null
  binding.watchGeneration += 1
  clearTimer(binding)
  binding.pending = null
  binding.stopWatch?.()
  binding.stopWatch = null
  if (typeof window === 'undefined') return
  window.removeEventListener('focus', binding.onFocus)
  document.removeEventListener('visibilitychange', binding.onVisibility)
}

function schedule(binding: RefreshBinding, mode: 'full' | readonly string[]) {
  const vault = bindingHost(binding)
  if (!vault || current !== binding || vault.session !== binding.session) return
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
  const pending = binding.pending ?? { full: false, paths: new Set<string>() }
  if (mode === 'full') pending.full = true
  else if (!pending.full) {
    for (const path of mode) pending.paths.add(path)
  }
  binding.pending = pending
  clearTimer(binding)
  binding.timer = setTimeout(() => {
    binding.timer = null
    void flushPending(binding)
  }, REFRESH_DEBOUNCE_MS)
}

async function flushPending(binding: RefreshBinding) {
  const vault = bindingHost(binding)
  const pending = binding.pending
  binding.pending = null
  if (!vault || !pending || current !== binding || vault.session !== binding.session) return
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
  if (pending.full) {
    binding.handlers.full()
    return
  }
  const fs = vault.fs
  if (!fs || pending.paths.size === 0) return
  let plan: 'full' | string[]
  try {
    plan = await classifyWatchedPaths(fs, [...pending.paths])
  } catch {
    plan = 'full'
  }
  if (current !== binding || vault.session !== binding.session) return
  if (plan === 'full') binding.handlers.full()
  else if (plan.length > 0) binding.handlers.paths(plan)
}

function bindingHost(binding: RefreshBinding): VaultService | null {
  if (current !== binding) return null
  return binding.vault as VaultService
}

async function attachDiskWatch(vault: VaultService, binding: RefreshBinding) {
  const fs = vault.fs
  if (!fs || !shouldAttachDiskWatch(fs, vault.broad)) return
  const generation = binding.watchGeneration
  let stop: () => void
  try {
    stop = await fs.watch('', (event: WatchEvent) => {
      if (current !== binding || vault.session !== binding.session) return
      if (ignoredWatchPath(event.path)) return
      if (!event.path) {
        schedule(binding, 'full')
        return
      }
      schedule(binding, [event.path])
    })
  } catch {
    console.warn('stride vault watch: unavailable')
    return
  }
  if (current !== binding || binding.watchGeneration !== generation) {
    stop()
    return
  }
  binding.stopWatch = stop
}

/** Focus refresh always; OS watch only for a real, non-broad vault. Replaces any previous binding. */
export function bindVaultRefresh(vault: VaultService, handlers: VaultRefreshHandlers): void {
  unbindCurrent()
  const binding: RefreshBinding = {
    vault: raw(vault) as object,
    session: vault.session,
    watchGeneration: 0,
    stopWatch: null,
    timer: null,
    pending: null,
    onFocus: () => schedule(binding, 'full'),
    onVisibility: () => schedule(binding, 'full'),
    handlers,
  }
  current = binding
  if (typeof window !== 'undefined') {
    window.addEventListener('focus', binding.onFocus)
    document.addEventListener('visibilitychange', binding.onVisibility)
  }
  void attachDiskWatch(vault, binding)
}

export function unbindVaultRefresh(vault: VaultService): void {
  if (!current || current.vault !== (raw(vault) as object)) return
  unbindCurrent()
}
