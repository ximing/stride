import { isDesktopRuntime } from './runtime'

/** Webview `fetch` is subject to CORS. Desktop calls the streaming host helper and forwards `init`, including `AbortSignal`. */
export function hostFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  if (!isDesktopRuntime()) return globalThis.fetch(input, init)
  return import('@stride/electron-api').then(({ hostFetch: nativeFetch }) => nativeFetch(input, init))
}
