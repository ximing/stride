const BROAD_BASENAMES = new Set(['desktop', 'documents', 'downloads'])

// Lexical POSIX normalize. Callers pass absolute paths, so this does not consult a cwd.
function normalizeHostPath(input: string): string {
  let slashed = input.replaceAll('\\', '/')
  const drive = /^[A-Za-z]:/.exec(slashed)
  const prefix = drive?.[0] ?? ''
  if (prefix) slashed = slashed.slice(prefix.length)
  const absolute = slashed.startsWith('/')
  const parts: string[] = []
  for (const segment of slashed.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (parts.length > 0) parts.pop()
      continue
    }
    parts.push(segment)
  }
  const body = parts.join('/')
  if (prefix) return absolute ? `${prefix}/${body}` : `${prefix}${body}`
  return absolute ? `/${body}` : body
}

export function isBroadPersonalRoot(target: string, homeDir: string): boolean {
  const resolved = normalizeHostPath(target)
  const home = normalizeHostPath(homeDir)
  if (resolved === home) return true
  const base = resolved.split('/').pop()?.toLowerCase() ?? ''
  return BROAD_BASENAMES.has(base)
}

export const DEDICATED_ERROR =
  'Choose a dedicated vault folder before initializing Git. This path looks like a broad personal folder.'
