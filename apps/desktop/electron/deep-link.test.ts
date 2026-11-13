import { describe, expect, it } from 'vitest'
import { createDeepLinkQueue, handleOpenUrl, isStrideUrl, strideUrlsFromAdditional, strideUrlsFromArgv } from './deep-link.ts'

describe('deep link queue', () => {
  it('keeps stride urls from argv until a window can take them', () => {
    expect(strideUrlsFromArgv(['electron', 'app', 'stride://open?vault=/tmp/stride-e05a-not-a-vault'])).toEqual([
      'stride://open?vault=/tmp/stride-e05a-not-a-vault',
    ])
    expect(isStrideUrl('https://example.test')).toBe(false)
    const queue = createDeepLinkQueue()
    queue.push('https://example.test')
    queue.push('stride://focus')
    const seen: string[] = []
    queue.drain((url) => seen.push(url))
    queue.push('STRIDE://again')
    expect(seen).toEqual(['stride://focus', 'STRIDE://again'])
  })

  it('lets the unlocked process leave open-url to the primary instance', () => {
    const pushed: string[] = []
    let prevented = 0
    handleOpenUrl(false, 'stride://focus', () => {
      prevented += 1
    }, (url) => pushed.push(url))
    expect(prevented).toBe(0)
    expect(pushed).toEqual([])
    handleOpenUrl(true, 'stride://focus', () => {
      prevented += 1
    }, (url) => pushed.push(url))
    expect(prevented).toBe(1)
    expect(pushed).toEqual(['stride://focus'])
    expect(strideUrlsFromAdditional({ strideUrls: ['stride://open?vault=/tmp/a', 'https://nope.example'] })).toEqual([
      'stride://open?vault=/tmp/a',
    ])
  })
})
