import { electronBridge, type ElectronBridge } from './index.ts'

/** Optional one-shot base64 seal key from the renderer IndexedDB migration. */
export interface SealKeyRequest {
  legacy?: string
}

function bridge(): ElectronBridge {
  return electronBridge()
}

function sealKeyRequest(legacy: string | undefined): SealKeyRequest | undefined {
  if (legacy === undefined) return undefined
  return { legacy }
}

/**
 * Ask the main process for the 32-byte AES seal key, base64-encoded.
 * The main process stores only safeStorage ciphertext. This helper never persists the key.
 */
export async function getOrCreateSealKey(legacy?: string): Promise<string> {
  const request = sealKeyRequest(legacy)
  const result = await bridge().invoke('secrets:getOrCreateKey', request)
  if (typeof result !== 'string' || result.length === 0) {
    throw new Error('Rejected invalid seal key')
  }
  return result
}
