import dictBinUrl from '@vane-rs/dict-zh/dict.bin?url'
import dictSha256Url from '@vane-rs/dict-zh/sha256_prefix.bin?url'
import { PlatformError } from '@stride/platform'

export interface JiebaDict {
  dictData: Uint8Array
  dictSha256: string
}

function hexOf(bytes: Uint8Array): string {
  let hex = ''
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0')
  return hex
}

async function fetchBytes(url: string, label: string): Promise<Uint8Array> {
  let response: Response
  try {
    response = await fetch(url)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new PlatformError('io', `Failed to read ${label}: ${detail}`)
  }
  if (!response.ok) {
    throw new PlatformError('io', `Failed to read ${label}: HTTP ${response.status}`)
  }
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength === 0) throw new PlatformError('io', `Failed to read ${label}: empty file`)
  return bytes
}

async function readPackagedJiebaDict(): Promise<JiebaDict> {
  const dictData = await fetchBytes(dictBinUrl, 'jieba dict.bin')
  const prefix = await fetchBytes(dictSha256Url, 'jieba sha256 prefix')
  const dictSha256 = hexOf(prefix)
  if (!/^[0-9a-f]{16}$/.test(dictSha256)) {
    throw new PlatformError('io', 'Jieba dictionary sha256 prefix is not 16 hex characters')
  }
  return { dictData, dictSha256 }
}

let pending: Promise<JiebaDict> | undefined

// Vite resolves the package exports to asset URLs. Fetch those bytes; never fall back to a CDN URL.
export function loadPackagedJiebaDict(): Promise<JiebaDict> {
  pending ??= readPackagedJiebaDict().catch((error: unknown) => {
    pending = undefined
    throw error
  })
  return pending
}
