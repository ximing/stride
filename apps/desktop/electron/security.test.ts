// @vitest-environment node
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  assertTrustedDevUrl,
  assertTrustedSender,
  installNavigationGuards,
  isTrustedRendererUrl,
  resolveRendererTrust,
  type NavigationGuardedWindow,
  type RendererTrust,
} from './security.ts'

const DEV = 'http://127.0.0.1:1421/'
const devTrust: RendererTrust = { packaged: false, devUrl: DEV }
const indexPath = '/tmp/stride-packaged/dist/index.html'
const packagedTrust: RendererTrust = { packaged: true, appIndexPath: indexPath }

function indexUrl(extra = ''): string {
  return pathToFileURL(indexPath).href + extra
}

function guarded(trust: RendererTrust = devTrust) {
  const listeners = new Map<string, (event: { preventDefault(): void }, url: string) => void>()
  const window: NavigationGuardedWindow = {
    webContents: {
      on(event, listener) {
        listeners.set(event, listener)
      },
    },
  }
  installNavigationGuards(window, trust)
  return (event: string, url: string) => {
    let prevented = false
    const handler = listeners.get(event)
    if (!handler) throw new Error(`missing ${event}`)
    handler({ preventDefault() { prevented = true } }, url)
    return prevented
  }
}

describe('isTrustedRendererUrl', () => {
  it('allows same-origin dev paths and rejects other origins', () => {
    expect(isTrustedRendererUrl('http://127.0.0.1:1421/', devTrust)).toBe(true)
    expect(isTrustedRendererUrl('http://127.0.0.1:1421/assets/main.js', devTrust)).toBe(true)
    expect(isTrustedRendererUrl('http://127.0.0.1:1421/index.html?x=1#top', devTrust)).toBe(true)
    expect(isTrustedRendererUrl('http://127.0.0.1:9999/', devTrust)).toBe(false)
    expect(isTrustedRendererUrl('http://localhost:1421/', devTrust)).toBe(false)
    expect(isTrustedRendererUrl('https://127.0.0.1:1421/', devTrust)).toBe(false)
    expect(isTrustedRendererUrl('http://evil.example/', devTrust)).toBe(false)
    expect(isTrustedRendererUrl('file:///tmp/index.html', devTrust)).toBe(false)
  })

  it('rejects a dev URL that is not http loopback even when the origin matches', () => {
    expect(() => assertTrustedDevUrl('https://127.0.0.1:1421/')).toThrow(/loopback/)
    expect(() => assertTrustedDevUrl('http://example.com:1421/')).toThrow(/loopback/)
    expect(() => assertTrustedDevUrl('http://192.168.1.10:1421/')).toThrow(/loopback/)
    expect(() => resolveRendererTrust({ packaged: false, devUrl: 'http://example.com/' })).toThrow(/loopback/)
    expect(isTrustedRendererUrl('http://example.com/', { packaged: false, devUrl: 'http://example.com/' })).toBe(false)
    expect(assertTrustedDevUrl('http://localhost:1421/').origin).toBe('http://localhost:1421')
    expect(assertTrustedDevUrl('http://[::1]:1421/').hostname).toBe('[::1]')
  })

  it('allows only the packaged index file, including query and hash', () => {
    expect(isTrustedRendererUrl(indexUrl(), packagedTrust)).toBe(true)
    expect(isTrustedRendererUrl(indexUrl('?panel=search'), packagedTrust)).toBe(true)
    expect(isTrustedRendererUrl(indexUrl('#note'), packagedTrust)).toBe(true)
    expect(isTrustedRendererUrl(pathToFileURL('/tmp/other/index.html').href, packagedTrust)).toBe(false)
    expect(isTrustedRendererUrl('https://127.0.0.1:1421/', packagedTrust)).toBe(false)
    expect(isTrustedRendererUrl('file:///etc/passwd', packagedTrust)).toBe(false)
  })
})

describe('navigation guards', () => {
  it('blocks untrusted top-level redirects and subframe navigations', () => {
    const fire = guarded()
    expect(fire('will-navigate', 'http://127.0.0.1:1421/notes')).toBe(false)
    expect(fire('will-navigate', 'https://evil.example/')).toBe(true)
    expect(fire('will-redirect', 'http://evil.example/phish')).toBe(true)
    expect(fire('will-redirect', 'http://127.0.0.1:1421/ok')).toBe(false)
    expect(fire('will-frame-navigate', 'https://cdn.example/frame')).toBe(true)
    expect(fire('will-frame-navigate', 'http://127.0.0.1:1421/embed')).toBe(false)
  })

  it('treats malformed percent-encoding as untrusted and still blocks about:blank and about:srcdoc', () => {
    expect(isTrustedRendererUrl('file:///tmp/%ZZ', packagedTrust)).toBe(false)
    expect(isTrustedRendererUrl('file:///tmp/%', packagedTrust)).toBe(false)
    expect(isTrustedRendererUrl('about:blank', devTrust)).toBe(false)
    expect(isTrustedRendererUrl('about:srcdoc', devTrust)).toBe(false)
    expect(isTrustedRendererUrl('about:blank', packagedTrust)).toBe(false)
    expect(isTrustedRendererUrl('about:srcdoc', packagedTrust)).toBe(false)
    const fire = guarded(packagedTrust)
    expect(fire('will-navigate', 'file:///tmp/%ZZ')).toBe(true)
    expect(fire('will-navigate', 'file:///tmp/%')).toBe(true)
    expect(fire('will-redirect', 'about:blank')).toBe(true)
    expect(fire('will-frame-navigate', 'about:srcdoc')).toBe(true)
    expect(fire('will-navigate', indexUrl())).toBe(false)
  })
})

describe('assertTrustedSender', () => {
  it('rejects IPC whose sender URL is not the trusted renderer', () => {
    expect(() => assertTrustedSender({ sender: { getURL: () => 'http://127.0.0.1:1421/' } }, devTrust)).not.toThrow()
    expect(() => assertTrustedSender({ sender: { getURL: () => 'https://evil.example/' } }, devTrust)).toThrow(/untrusted renderer/)
    expect(() => assertTrustedSender({ sender: { getURL: () => '' } }, devTrust)).toThrow(/untrusted renderer/)
    expect(() => assertTrustedSender({
      sender: { getURL: () => { throw new Error('destroyed') } },
    }, devTrust)).toThrow(/untrusted renderer/)
    expect(() => assertTrustedSender({ sender: { getURL: () => indexUrl('?q=1') } }, packagedTrust)).not.toThrow()
    expect(() => assertTrustedSender({ sender: { getURL: () => 'file:///tmp/other.html' } }, packagedTrust)).toThrow(/untrusted renderer/)
  })
})
