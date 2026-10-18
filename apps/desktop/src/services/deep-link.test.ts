import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEEP_LINK_EVENT,
  DEEP_LINK_SCHEME,
  describeDeepLink,
  parseDeepLink,
  startDeepLinkListener,
  type DeepLinkApi,
} from './deep-link'

function flush(): Promise<void> {
  // Two microtask ticks: subscribe promise -> unlisten assignment.
  return Promise.resolve()
    .then(() => undefined)
    .then(() => undefined)
}

describe('parseDeepLink', () => {
  it('parses an open action with a vault param', () => {
    const link = parseDeepLink('stride://open?vault=/tmp/notes')
    expect(link).not.toBeNull()
    expect(link!.action).toBe('open')
    expect(link!.params.get('vault')).toBe('/tmp/notes')
    expect(link!.url).toBe('stride://open?vault=/tmp/notes')
  })

  it('accepts an uppercase scheme and action', () => {
    const link = parseDeepLink('STRIDE://Open?vault=x')
    expect(link).not.toBeNull()
    expect(link!.action).toBe('open')
  })

  it('accepts deep links without params', () => {
    const link = parseDeepLink('stride://focus')
    expect(link).not.toBeNull()
    expect(link!.action).toBe('focus')
    expect(link!.params.get('vault')).toBeNull()
  })

  it('rejects other schemes', () => {
    expect(parseDeepLink('https://open?vault=x')).toBeNull()
    expect(parseDeepLink('mailto:x@y.z')).toBeNull()
    expect(parseDeepLink('strides://open')).toBeNull()
  })

  it('rejects junk', () => {
    expect(parseDeepLink('not a url')).toBeNull()
    expect(parseDeepLink('')).toBeNull()
    expect(parseDeepLink('stride://')).toBeNull()
  })
})

describe('describeDeepLink', () => {
  it('mentions the vault when present', () => {
    expect(describeDeepLink(parseDeepLink('stride://open?vault=/a')!)).toBe(
      'deep link open (vault=/a)',
    )
  })

  it('mentions only the action otherwise', () => {
    expect(describeDeepLink(parseDeepLink('stride://focus')!)).toBe('deep link focus')
  })
})

describe('startDeepLinkListener', () => {
  const handlers = new Set<(urls: string[]) => void>()

  function fakeApi(): DeepLinkApi {
    return {
      onOpenUrl(handler) {
        handlers.add(handler)
        return Promise.resolve(() => {
          handlers.delete(handler)
        })
      },
    }
  }

  function emitDeepLink(urls: string[]): void {
    for (const handler of handlers) handler(urls)
  }

  afterEach(() => {
    handlers.clear()
    vi.restoreAllMocks()
  })

  it('is a graceful no-op outside Tauri (no api injected)', async () => {
    const error = vi.fn()
    const dispose = startDeepLinkListener({ onError: error })
    await flush()
    expect(error).not.toHaveBeenCalled()
    expect(() => dispose()).not.toThrow()
  })

  it('delivers parsed stride:// urls to onReceive', async () => {
    const onReceive = vi.fn()
    const dispose = startDeepLinkListener({ getApi: fakeApi, onReceive })
    await flush()
    emitDeepLink(['stride://open?vault=/tmp/notes', 'https://ignored.example/'])
    expect(onReceive).toHaveBeenCalledTimes(1)
    expect(onReceive.mock.calls[0]![0]).toMatchObject({
      action: 'open',
      url: 'stride://open?vault=/tmp/notes',
    })
    dispose()
    emitDeepLink(['stride://open?vault=/again'])
    expect(onReceive).toHaveBeenCalledTimes(1)
  })

  it('default handler logs and re-broadcasts on the DOM', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const received: unknown[] = []
    const handler = (event: Event) => received.push((event as CustomEvent).detail)
    window.addEventListener(DEEP_LINK_EVENT, handler)
    const dispose = startDeepLinkListener({ getApi: fakeApi })
    await flush()
    emitDeepLink(['stride://open?vault=/tmp/v'])
    expect(info).toHaveBeenCalledWith('[deep-link] received deep link open (vault=/tmp/v)')
    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({ action: 'open' })
    window.removeEventListener(DEEP_LINK_EVENT, handler)
    dispose()
  })

  it('warns when subscription fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const dispose = startDeepLinkListener({
      getApi: () => {
        throw new Error('no plugin')
      },
    })
    await flush()
    expect(warn).toHaveBeenCalledOnce()
    dispose()
  })

  it('scheme constant stays stride', () => {
    expect(DEEP_LINK_SCHEME).toBe('stride')
  })
})
