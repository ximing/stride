import { describe, expect, it } from 'vitest'
import { NodeSecretsStore } from './secrets.ts'

describe('node secrets', () => {
  it('seals empty plaintext as an empty string and opens across instances', async () => {
    const store = new NodeSecretsStore()
    expect(await store.seal('')).toBe('')
    expect(await store.open('')).toBe('')
    const sealed = await store.seal('sk-stride-embed-test-key')
    expect(sealed).not.toContain('sk-stride-embed-test-key')
    expect(await new NodeSecretsStore().open(sealed)).toBe('sk-stride-embed-test-key')
  })
})
