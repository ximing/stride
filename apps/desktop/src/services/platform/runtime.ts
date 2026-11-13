/** Host runtime probes. Desktop detection is the Electron bridge on `window`. */

export function isDesktopRuntime(): boolean {
  return typeof window !== 'undefined' && '__STRIDE_ELECTRON__' in window
}

export function isMemoryFixture(): boolean {
  if (typeof window === 'undefined') return false
  return new URLSearchParams(window.location.search).get('fixture') === 'memory'
}
