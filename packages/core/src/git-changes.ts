import { vaultRelative } from './git.ts'

export interface GitChange {
  path: string
  code: string
  staged: boolean
  unstaged: boolean
  untracked: boolean
  unmerged: boolean
}

const gitPathText = new TextDecoder()

const namedEscape: Record<string, number> = {
  '"': 0x22,
  '\\': 0x5c,
  a: 0x07,
  b: 0x08,
  f: 0x0c,
  n: 0x0a,
  r: 0x0d,
  t: 0x09,
  v: 0x0b,
}

function malformedPath(): never {
  throw new Error('Malformed git path')
}

function pushCodePoint(bytes: number[], codePoint: number): void {
  if (codePoint < 0x80) {
    bytes.push(codePoint)
    return
  }
  if (codePoint < 0x800) {
    bytes.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f))
    return
  }
  if (codePoint < 0x10000) {
    bytes.push(0xe0 | (codePoint >> 12), 0x80 | ((codePoint >> 6) & 0x3f), 0x80 | (codePoint & 0x3f))
    return
  }
  bytes.push(
    0xf0 | (codePoint >> 18),
    0x80 | ((codePoint >> 12) & 0x3f),
    0x80 | ((codePoint >> 6) & 0x3f),
    0x80 | (codePoint & 0x3f),
  )
}

// Git C quoting (unquote_c_style): octal is three digits and the first is 0-3.
// quotePath=false still quotes spaces, so a quoted body may already be Unicode.
function readQuoted(line: string, start: number): { path: string; end: number } {
  if (line[start] !== '"') malformedPath()
  const bytes: number[] = []
  let i = start + 1
  while (i < line.length) {
    const ch = line[i]
    if (ch === '"') return { path: gitPathText.decode(Uint8Array.from(bytes)), end: i + 1 }
    if (ch !== '\\') {
      const codePoint = line.codePointAt(i)
      if (codePoint === undefined) malformedPath()
      pushCodePoint(bytes, codePoint)
      i += codePoint > 0xffff ? 2 : 1
      continue
    }
    const esc = line[++i]
    if (esc === undefined) malformedPath()
    const named = namedEscape[esc]
    if (named !== undefined) {
      bytes.push(named)
      i += 1
      continue
    }
    const d1 = line[i + 1]
    const d2 = line[i + 2]
    if (esc < '0' || esc > '3' || d1 === undefined || d1 < '0' || d1 > '7' || d2 === undefined || d2 < '0' || d2 > '7') {
      malformedPath()
    }
    bytes.push(((esc.charCodeAt(0) - 48) << 6) | ((d1.charCodeAt(0) - 48) << 3) | (d2.charCodeAt(0) - 48))
    i += 3
  }
  malformedPath()
}

function readPath(line: string, start: number, restIsPath: boolean): { path: string; end: number } {
  if (start >= line.length) throw new Error('Malformed git status')
  if (line[start] === '"') {
    const quoted = readQuoted(line, start)
    if (restIsPath && quoted.end !== line.length) throw new Error('Malformed git status')
    return quoted
  }
  if (restIsPath) return { path: line.slice(start), end: line.length }
  let end = start
  while (end < line.length && line[end] !== ' ') end += 1
  if (end === start) throw new Error('Malformed git status')
  return { path: line.slice(start, end), end }
}

// Porcelain prints "ORIG -> PATH" only when a status letter is R or C.
function hasRenameArrow(code: string): boolean {
  return code[0] === 'R' || code[0] === 'C' || code[1] === 'R' || code[1] === 'C'
}

function recordPath(code: string, rest: string): string {
  if (!hasRenameArrow(code)) return readPath(rest, 0, true).path
  const source = readPath(rest, 0, false)
  if (!rest.startsWith(' -> ', source.end)) throw new Error('Malformed git status')
  return readPath(rest, source.end + 4, true).path
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
    const path = recordPath(code, raw.slice(3))
    vaultRelative(path)
    changes.push({ path, code, ...flags(code) })
  }
  return changes
}
