// T8.6: `stride://` deep link plumbing.
//
// Scope for this phase: register the scheme (Rust plugin + tauri.conf.json),
// receive deep link events, log them and re-broadcast on the DOM so future
// phases can react. Opening a specific vault from `stride://open?vault=...`
// is deliberately left to Phase 9.

export const DEEP_LINK_SCHEME = 'stride'
export const DEEP_LINK_EVENT = 'stride:deep-link'

/** A parsed `stride://` URL, e.g. `stride://open?vault=/tmp/notes`. */
export interface DeepLink {
  /** URL host segment; the deep link "action", e.g. `open`. */
  action: string
  /** Query string parameters (`?vault=...`). */
  params: URLSearchParams
  /** The raw URL as received. */
  url: string
}

/** Parse and validate a deep link URL. Returns null for other schemes or junk. */
export function parseDeepLink(raw: string): DeepLink | null {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return null
  }
  // `new URL('STRIDE://open')` keeps the scheme verbatim, so compare lowercased.
  if (parsed.protocol.replace(/:$/, '').toLowerCase() !== DEEP_LINK_SCHEME) return null
  if (!parsed.hostname) return null
  return { action: parsed.hostname.toLowerCase(), params: parsed.searchParams, url: raw }
}

/** Human-readable summary used for logging / future toasts. */
export function describeDeepLink(link: DeepLink): string {
  const vault = link.params.get('vault')
  return vault ? `deep link ${link.action} (vault=${vault})` : `deep link ${link.action}`
}

/** Minimal surface of the Tauri deep link plugin the listener needs. */
export interface DeepLinkApi {
  onOpenUrl(handler: (urls: string[]) => void): Promise<() => void>
}

import { isTauriRuntime } from './runtime'

export { isTauriRuntime }

export interface DeepLinkListenerOptions {
  /** Injectable for tests. Returning null disables the listener. */
  getApi?: () => DeepLinkApi | null
  /** Called for every received `stride://` URL. Defaults to log + DOM event. */
  onReceive?: (link: DeepLink) => void
  /** Called if subscribing fails; defaults to a console warning. */
  onError?: (error: unknown) => void
}

function defaultOnReceive(link: DeepLink): void {
  const summary = describeDeepLink(link)
  // The visible acknowledgment for this phase: a console line plus a DOM
  // event any UI can subscribe to later (Phase 9 wires vault opening).
  console.info(`[deep-link] received ${summary}`)
  window.dispatchEvent(new CustomEvent<DeepLink>(DEEP_LINK_EVENT, { detail: link }))
}

/**
 * Subscribe to `stride://` deep link events. In a plain browser (dev server,
 * vitest) this is a graceful no-op: the Tauri deep link plugin simply does not
 * exist there.
 *
 * Returns a disposer that unsubscribes (safe to call more than once).
 */
export function startDeepLinkListener(options: DeepLinkListenerOptions = {}): () => void {
  const { getApi, onReceive = defaultOnReceive, onError } = options
  let disposed = false
  let unsubscribe: (() => void) | null = null

  const resolveApi = (): Promise<DeepLinkApi | null> => {
    try {
      if (getApi) return Promise.resolve(getApi())
      if (!isTauriRuntime()) return Promise.resolve(null)
      // Lazy import keeps the plugin out of plain-browser bundles.
      return import('@tauri-apps/plugin-deep-link').then(
        ({ onOpenUrl }) => ({ onOpenUrl }) as DeepLinkApi,
      )
    } catch (error) {
      return Promise.reject(error)
    }
  }

  void resolveApi()
    .then((api) => {
      if (disposed || !api) return null
      return api
        .onOpenUrl((urls) => {
          for (const url of urls) {
            const link = parseDeepLink(url)
            if (link) onReceive(link)
          }
        })
        .then((unlisten) => {
          if (disposed) {
            unlisten()
            return null
          }
          unsubscribe = unlisten
          return null
        })
    })
    .catch((error: unknown) => {
      if (!disposed) (onError ?? warn)(error)
    })

  return () => {
    disposed = true
    unsubscribe?.()
    unsubscribe = null
  }
}

function warn(error: unknown): void {
  console.warn('[deep-link] listener setup failed', error)
}
