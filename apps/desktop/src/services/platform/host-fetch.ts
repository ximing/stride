import { isDesktopRuntime } from './runtime'

/** Webview `fetch` is subject to CORS. Desktop LLM hosts often omit ACAO, so Tauri uses native HTTP. */
export function hostFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  if (!isDesktopRuntime()) return globalThis.fetch(input, init)
  return import('@tauri-apps/plugin-http').then(({ fetch }) => fetch(input, init))
}
