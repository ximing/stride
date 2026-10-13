import path from 'node:path'

const BROAD_BASENAMES = new Set(['desktop', 'documents', 'downloads'])

export function isBroadPersonalRoot(target: string, homeDir: string): boolean {
  const resolved = path.resolve(target)
  const home = path.resolve(homeDir)
  if (resolved === home) return true
  const base = path.basename(resolved).toLowerCase()
  return BROAD_BASENAMES.has(base)
}

export const DEDICATED_ERROR =
  'Choose a dedicated vault folder before initializing Git. This path looks like a broad personal folder.'
