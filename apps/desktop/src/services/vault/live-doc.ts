import { raw } from '@rabjs/react'
import type { TipTapNode } from '@stride/core/note'

/**
 * In-flight body edits, keyed by note id and kept OUTSIDE the reactive
 * `notes` array. `VaultService.updateDoc` runs on every keystroke; committing
 * each one into `notes` would replace the array and invalidate every
 * notes-derived derivation in the vault (graph, note list, folder tree) per
 * keystroke. The stash merges into `VaultService.active` on read and is
 * committed to `notes` by the debounced flush.
 */
const stashes = new WeakMap<object, Map<string, TipTapNode>>()

export function liveDocStash(host: object): Map<string, TipTapNode> {
  const key = raw(host) as object
  let stash = stashes.get(key)
  if (!stash) {
    stash = new Map()
    stashes.set(key, stash)
  }
  return stash
}
