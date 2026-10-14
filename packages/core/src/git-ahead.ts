export function parseAheadBehind(revListCounts: string): { ahead: number; behind: number } {
  const text = revListCounts.trim()
  if (!text) return { ahead: 0, behind: 0 }
  const match = /^(\d+)\t(\d+)$/.exec(text)
  if (!match) throw new Error('Malformed ahead/behind counts')
  return { ahead: Number(match[1]), behind: Number(match[2]) }
}

export function parseStatusBranch(firstLine: string): {
  branch: string
  ahead: number
  behind: number
  hasUpstream: boolean
} {
  const line = firstLine.trim()
  if (!line) throw new Error('Missing status branch')
  const head = /^## HEAD \(no branch\)$/.exec(line)
  if (head) return { branch: 'HEAD', ahead: 0, behind: 0, hasUpstream: false }
  const plain = /^## ([^\s.]+)(?:\.\.\.[^\s]+)?(?: \[(.+)\])?$/.exec(line)
  if (!plain || !plain[1]) throw new Error('Malformed status branch')
  let ahead = 0
  let behind = 0
  const extra = plain[2] ?? ''
  const aheadMatch = /ahead (\d+)/.exec(extra)
  const behindMatch = /behind (\d+)/.exec(extra)
  if (aheadMatch?.[1]) ahead = Number(aheadMatch[1])
  if (behindMatch?.[1]) behind = Number(behindMatch[1])
  const hasUpstream = line.includes('...')
  return { branch: plain[1], ahead, behind, hasUpstream }
}
