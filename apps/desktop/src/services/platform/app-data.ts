import { MemoryAppDataStore, type AppDataStore } from '@stride/platform'
import { isDesktopRuntime, isMemoryFixture } from './runtime'

export interface AppDataResolution {
  store: AppDataStore
  /** False when the store only lives in memory (memory fixture or IDB denied). */
  persistent: boolean
}

type AppDataSource = AppDataResolution | (() => Promise<AppDataResolution> | AppDataResolution)

let override: AppDataSource | null = null
let cached: Promise<AppDataResolution> | null = null

export function setAppDataStore(next: AppDataSource | null) {
  override = next
  cached = null
}

export function resetAppDataStore() {
  override = null
  cached = null
}

/**
 * Single entry point for the AppDataStore port (chat sessions, long-term
 * memory). Desktop writes under `~/.stride/`; the browser uses IndexedDB and
 * degrades to memory when IDB is unavailable — check `persistent`.
 */
export function resolveAppDataStore(): Promise<AppDataResolution> {
  if (override) {
    return Promise.resolve(typeof override === 'function' ? override() : override)
  }
  if (!cached) cached = openAppDataStore()
  return cached
}

async function openAppDataStore(): Promise<AppDataResolution> {
  if (isMemoryFixture()) return { store: new MemoryAppDataStore(), persistent: false }
  if (isDesktopRuntime()) {
    const { tauriAppDataStore } = await import('@stride/appdata-tauri')
    return { store: await tauriAppDataStore(), persistent: true }
  }
  const { webAppDataStore } = await import('@stride/appdata-web')
  return webAppDataStore()
}
