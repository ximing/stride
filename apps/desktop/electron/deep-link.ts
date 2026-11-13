const STRIDE_URL = /^stride:/i

export function isStrideUrl(value: string): boolean {
  return STRIDE_URL.test(value)
}

export function strideUrlsFromArgv(argv: readonly string[]): string[] {
  return argv.filter(isStrideUrl)
}

export function strideUrlsFromAdditional(value: unknown): string[] {
  if (!value || typeof value !== 'object') return []
  const urls = (value as { strideUrls?: unknown }).strideUrls
  if (!Array.isArray(urls)) return []
  return urls.filter((item): item is string => typeof item === 'string' && isStrideUrl(item))
}

/** The process that lost the single-instance lock must not consume macOS open-url. */
export function handleOpenUrl(
  hasLock: boolean,
  url: string,
  preventDefault: () => void,
  push: (url: string) => void,
): void {
  if (!hasLock) return
  preventDefault()
  push(url)
}

export function createDeepLinkQueue(): {
  push(url: string): void
  drain(deliver: (url: string) => void): void
} {
  const pending: string[] = []
  let deliver: ((url: string) => void) | null = null
  return {
    push(url: string) {
      if (!isStrideUrl(url)) return
      if (deliver) deliver(url)
      else pending.push(url)
    },
    drain(next: (url: string) => void) {
      deliver = next
      const queued = pending.splice(0, pending.length)
      for (const url of queued) next(url)
    },
  }
}
