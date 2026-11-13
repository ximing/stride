import { afterEach, describe, expect, it, vi } from 'vitest'
import { hostFetch } from './host-fetch'

describe('hostFetch', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('uses the page fetch when there is no desktop bridge', async () => {
    const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const result = await hostFetch('https://example.com/v1')
    expect(fetchMock).toHaveBeenCalled()
    expect(result.status).toBe(200)
  })
})
