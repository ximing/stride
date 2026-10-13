import { PlatformError } from './error.ts'

export interface SecretsStore {
  seal(plaintext: string): Promise<string>
  open(sealed: string): Promise<string>
}

function asBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buffer).set(bytes)
  return buffer
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]!)
  return btoa(binary)
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

export class MemorySecretsStore implements SecretsStore {
  // Random per instance and non-extractable, so another store cannot open the seal.
  private readonly key = globalThis.crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )

  async seal(plaintext: string): Promise<string> {
    if (plaintext === '') return ''
    const iv = new Uint8Array(12)
    globalThis.crypto.getRandomValues(iv)
    const encoded = new TextEncoder().encode(plaintext)
    const encrypted = new Uint8Array(
      await globalThis.crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: asBuffer(iv) },
        await this.key,
        asBuffer(encoded),
      ),
    )
    const packed = new Uint8Array(iv.length + encrypted.length)
    packed.set(iv, 0)
    packed.set(encrypted, iv.length)
    return encodeBase64(packed)
  }

  async open(sealed: string): Promise<string> {
    if (sealed === '') return ''
    try {
      const packed = decodeBase64(sealed)
      if (packed.length < 28) throw new Error('truncated')
      const plain = await globalThis.crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: asBuffer(packed.subarray(0, 12)) },
        await this.key,
        asBuffer(packed.subarray(12)),
      )
      return new TextDecoder().decode(plain)
    } catch (error) {
      if (error instanceof PlatformError) throw error
      throw new PlatformError('io', 'Failed to open sealed secret')
    }
  }
}
