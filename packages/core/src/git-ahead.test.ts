import { describe, expect, it } from 'vitest'
import { parseAheadBehind, parseStatusBranch } from './git-ahead.ts'

describe('parseAheadBehind', () => {
  it('parses left-right counts', () => {
    expect(parseAheadBehind('1\t0\n')).toEqual({ ahead: 1, behind: 0 })
    expect(parseAheadBehind('0\t2')).toEqual({ ahead: 0, behind: 2 })
  })

  it('treats blank output as no divergence', () => {
    expect(parseAheadBehind('')).toEqual({ ahead: 0, behind: 0 })
    expect(parseAheadBehind('  \n')).toEqual({ ahead: 0, behind: 0 })
  })

  it('throws on anything else', () => {
    expect(() => parseAheadBehind('1 0')).toThrow('Malformed ahead/behind counts')
    expect(() => parseAheadBehind('nope')).toThrow('Malformed ahead/behind counts')
    expect(() => parseAheadBehind('1\t2\t3')).toThrow('Malformed ahead/behind counts')
  })
})

describe('parseStatusBranch', () => {
  it('reads ahead and behind from a tracking branch', () => {
    expect(parseStatusBranch('## main...origin/main [ahead 1, behind 2]')).toEqual({
      branch: 'main',
      ahead: 1,
      behind: 2,
      hasUpstream: true,
    })
    expect(parseStatusBranch('## main...origin/main [ahead 1]')).toEqual({
      branch: 'main',
      ahead: 1,
      behind: 0,
      hasUpstream: true,
    })
    expect(parseStatusBranch('## main...origin/main [behind 3]')).toEqual({
      branch: 'main',
      ahead: 0,
      behind: 3,
      hasUpstream: true,
    })
  })

  it('reads a local branch with no upstream', () => {
    expect(parseStatusBranch('## main')).toEqual({
      branch: 'main',
      ahead: 0,
      behind: 0,
      hasUpstream: false,
    })
  })

  it('reads detached HEAD', () => {
    expect(parseStatusBranch('## HEAD (no branch)')).toEqual({
      branch: 'HEAD',
      ahead: 0,
      behind: 0,
      hasUpstream: false,
    })
  })

  it('throws when the branch line is missing or malformed', () => {
    expect(() => parseStatusBranch('')).toThrow('Missing status branch')
    expect(() => parseStatusBranch('   ')).toThrow('Missing status branch')
    expect(() => parseStatusBranch('not a branch')).toThrow('Malformed status branch')
  })
})
