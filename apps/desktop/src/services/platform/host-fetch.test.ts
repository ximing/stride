import { afterEach, describe, expect, it, vi } from 'vitest'
import { hostFetch } from './host-fetch'

describe('hostFetch', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('uses the page fetch outside Tauri', async () => {
    const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const result = await hostFetch('https://example.com/v1')
    expect(fetchMock).toHaveBeenCalled()
    expect(result.status).toBe(200)
  })
})
