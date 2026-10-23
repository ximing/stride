// Overlay cohort: quick open, vault search, and the command palette are modal
// dialogs that never stack — showing one closes the others, so a Mod-chord
// switches overlays instead of layering them. Each overlay service registers
// its closer lazily inside show(), which keeps this module dependency-free
// (no service imports, no cycles) and works no matter which subset of
// services a given runtime or test has registered.

const closers = new Map<string, () => void>()

/** Register `closeSelf` as the cohort closer for `self`, then close every other overlay. */
export function closeOtherOverlays(self: string, closeSelf: () => void): void {
  closers.set(self, closeSelf)
  for (const [id, close] of closers) {
    if (id !== self) close()
  }
}

/**
 * Close cohort members that have already registered a closer.
 * Does not register the caller, so find can dismiss the list panels without
 * joining the cohort (settings stays open, and opening settings does not close find).
 */
export function closeOverlays(ids: readonly string[]): void {
  for (const id of ids) closers.get(id)?.()
}
