import { describe, expect, it } from 'vitest'
import { sha256HexSync } from './sha256.ts'

async function subtleHex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text)
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

describe('sha256HexSync', () => {
  it('matches FIPS 180-2 empty and abc vectors', () => {
    expect(sha256HexSync(new TextEncoder().encode(''))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    )
    expect(sha256HexSync(new TextEncoder().encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })

  it('matches WebCrypto for the unconfigured embedding identity text', async () => {
    const text = 'v1\n1\n\n\n0\n'
    expect(sha256HexSync(new TextEncoder().encode(text))).toBe(await subtleHex(text))
  })

  it('matches WebCrypto across a padding boundary', async () => {
    const text = 'x'.repeat(55)
    expect(sha256HexSync(new TextEncoder().encode(text))).toBe(await subtleHex(text))
    const wrapped = 'y'.repeat(64)
    expect(sha256HexSync(new TextEncoder().encode(wrapped))).toBe(await subtleHex(wrapped))
  })
})
