/** Host runtime probes. The only production `'__TAURI_INTERNALS__'` literal lives here. */

export function isDesktopRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/** Existing public name. Same probe as `isDesktopRuntime`. */
export const isTauriRuntime = isDesktopRuntime

export function isMemoryFixture(): boolean {
  if (typeof window === 'undefined') return false
  return new URLSearchParams(window.location.search).get('fixture') === 'memory'
}
