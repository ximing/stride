import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import type { SecretsStore } from '@stride/platform'

// T0.7 replaces this key custody.
const SEAL_KEY = createHash('sha256').update('stride-settings-v1').digest()

export class NodeSecretsStore implements SecretsStore {
  async seal(plaintext: string): Promise<string> {
    if (plaintext === '') return ''
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', SEAL_KEY, iv)
    const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    return Buffer.concat([iv, tag, enc]).toString('base64')
  }

  async open(sealed: string): Promise<string> {
    if (sealed === '') return ''
    const buf = Buffer.from(sealed, 'base64')
    const iv = buf.subarray(0, 12)
    const tag = buf.subarray(12, 28)
    const enc = buf.subarray(28)
    const decipher = createDecipheriv('aes-256-gcm', SEAL_KEY, iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8')
  }
}
