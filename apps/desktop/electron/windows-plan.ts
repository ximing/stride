import type { WindowIntent } from '@stride/electron-api'
import { normalizePath } from './recent.ts'

export type Delivery =
  | { type: 'focus'; id: string }
  | { type: 'emit'; id: string }
  | { type: 'create' }

export function planDelivery(
  intent: WindowIntent,
  openPaths: ReadonlyMap<string, string>,
  reported: ReadonlySet<string>,
  focused: string | null,
): Delivery {
  if (intent.kind === 'fresh' || intent.kind === 'restore') return { type: 'create' }
  if (intent.kind === 'open') {
    const path = normalizePath(intent.path)
    const existing = labelForPath(path, openPaths, focused)
    if (existing) return { type: 'focus', id: existing }
    const empty = emptyReported(openPaths, reported, focused)
    return empty ? { type: 'emit', id: empty } : { type: 'create' }
  }
  const empty = emptyReported(openPaths, reported, focused)
  return empty ? { type: 'emit', id: empty } : { type: 'create' }
}

function labelForPath(
  path: string,
  openPaths: ReadonlyMap<string, string>,
  focused: string | null,
): string | null {
  if (focused && openPaths.get(focused) === path) return focused
  for (const [id, open] of openPaths) {
    if (open === path) return id
  }
  return null
}

function emptyReported(
  openPaths: ReadonlyMap<string, string>,
  reported: ReadonlySet<string>,
  focused: string | null,
): string | null {
  if (focused && reported.has(focused) && !openPaths.has(focused)) return focused
  for (const id of reported) {
    if (!openPaths.has(id)) return id
  }
  return null
}
