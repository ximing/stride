import { vaultRelative } from './git.ts'

export interface GitChange {
  path: string
  code: string
  staged: boolean
  unstaged: boolean
  untracked: boolean
  unmerged: boolean
}

function unquote(path: string): string {
  if (!path.startsWith('"')) return path
  if (!path.endsWith('"') || path.length < 2) throw new Error('Malformed git path')
  let out = ''
  const body = path.slice(1, -1)
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== '\\') {
      out += body[i]
      continue
    }
    const next = body[++i]
    if (next === undefined) throw new Error('Malformed git path')
    if (next === 'n') out += '\n'
    else if (next === 't') out += '\t'
    else if (next === '"' || next === '\\') out += next
    else throw new Error('Malformed git path')
  }
  return out
}

function flags(code: string): Pick<GitChange, 'staged' | 'unstaged' | 'untracked' | 'unmerged'> {
  const untracked = code === '??'
  const unmerged = code === 'UU' || code === 'AA' || code === 'DD' || code === 'AU' || code === 'UA' || code === 'DU' || code === 'UD'
  const x = code[0] ?? ' '
  const y = code[1] ?? ' '
  return {
    staged: !untracked && !unmerged && x !== ' ' && x !== '?',
    unstaged: !untracked && !unmerged && y !== ' ' && y !== '?',
    untracked,
    unmerged,
  }
}

export function parsePorcelain(porcelain: string): GitChange[] {
  if (!porcelain.trim()) return []
  const changes: GitChange[] = []
  for (const raw of porcelain.split('\n')) {
    if (!raw.trim()) continue
    if (raw.length < 4 || raw[2] !== ' ') throw new Error('Malformed git status')
    const code = raw.slice(0, 2)
    let path = unquote(raw.slice(3))
    const arrow = path.indexOf(' -> ')
    if (arrow !== -1) path = path.slice(arrow + 4)
    vaultRelative(path)
    changes.push({ path, code, ...flags(code) })
  }
  return changes
}
