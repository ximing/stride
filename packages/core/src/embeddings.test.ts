import { describe, expect, it } from 'vitest'
import { EmbeddingClient } from './embeddings.ts'
import { canonicalEmbeddingEndpoint } from './search-cache.ts'

const settings = {
  model: 'fixture-embed',
  apiKey: 'sk-test',
  dim: 2,
}

function clientFor(urls: string[]): EmbeddingClient {
  return new EmbeddingClient(async (input) => {
    urls.push(String(input))
    return new Response(JSON.stringify({
      data: [{ index: 0, embedding: [1, 0] }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  })
}

describe('embedding endpoint', () => {
  it('strips userinfo, query, fragment, default ports, and trailing slashes', async () => {
    expect(canonicalEmbeddingEndpoint('https://user:secret@API.Example.com:443/V1/?q=1#frag'))
      .toBe('https://api.example.com/V1')
    expect(canonicalEmbeddingEndpoint('http://user@example.com:80/v1///'))
      .toBe('http://example.com/v1')
    expect(canonicalEmbeddingEndpoint('https://example.com:8443/V1/'))
      .toBe('https://example.com:8443/V1')
    expect(canonicalEmbeddingEndpoint('api.example.com/V1/'))
      .toBe('api.example.com/V1')
    expect(canonicalEmbeddingEndpoint('  ')).toBe('')

    const urls: string[] = []
    const client = clientFor(urls)
    await client.embed(['hello'], { ...settings, endpoint: 'https://user:secret@API.Example.com:443/V1/?q=1#frag/' })
    await client.embed(['hello'], { ...settings, endpoint: 'http://embed.example:80/v1/' })
    await client.embed(['hello'], { ...settings, endpoint: 'https://example.com/KeepCase/' })
    expect(urls).toEqual([
      'https://api.example.com/V1/embeddings',
      'http://embed.example/v1/embeddings',
      'https://example.com/KeepCase/embeddings',
    ])
  })

  it('still rejects an empty endpoint before any request', async () => {
    const client = new EmbeddingClient(async () => {
      throw new Error('must not fetch')
    })
    await expect(client.embed(['hello'], { ...settings, endpoint: '   ' })).rejects.toThrow('No embedding endpoint')
    expect(client.calls).toBe(0)
  })

  it('rejects a hanging fetch when the passed signal aborts', async () => {
    const controller = new AbortController()
    let received: AbortSignal | null | undefined
    const client = new EmbeddingClient((_input, init) => new Promise((_resolve, reject) => {
      received = init?.signal
      const signal = init?.signal
      if (!signal) {
        reject(new Error('expected a signal'))
        return
      }
      const fail = () => {
        const reason = signal.reason
        reject(reason instanceof Error ? reason : new DOMException('The operation was aborted.', 'AbortError'))
      }
      if (signal.aborted) {
        fail()
        return
      }
      signal.addEventListener('abort', fail, { once: true })
    }))
    const pending = client.embed(
      ['hello'],
      { ...settings, endpoint: 'https://example.com/v1' },
      controller.signal,
    )
    expect(received).toBe(controller.signal)
    controller.abort()
    await expect(pending).rejects.toThrow(/abort/i)
  })
})
