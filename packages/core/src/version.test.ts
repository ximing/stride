import { describe, expect, it } from 'vitest'
import { compareVersions, parseVersion } from './version.ts'

describe('parseVersion', () => {
  it('parses dotted numeric parts', () => {
    expect(parseVersion('1.2.3')).toEqual([1, 2, 3])
  })

  it('strips a leading v and build metadata', () => {
    expect(parseVersion('v1.2.3+build5')).toEqual([1, 2, 3])
  })

  it('fills missing parts with zero', () => {
    expect(parseVersion('2')).toEqual([2, 0, 0])
    expect(parseVersion('0.10')).toEqual([0, 10, 0])
  })

  it('treats non-numeric parts as zero', () => {
    expect(parseVersion('1.x.4')).toEqual([1, 0, 4])
  })
})

describe('compareVersions', () => {
  it('compares equal versions as 0', () => {
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0)
    expect(compareVersions('v1.2.3', '1.2.3')).toBe(0)
    expect(compareVersions('1', '1.0.0')).toBe(0)
  })

  it('returns 1 when the left side is newer', () => {
    expect(compareVersions('1.2.4', '1.2.3')).toBe(1)
    expect(compareVersions('0.10.0', '0.9.9')).toBe(1)
    expect(compareVersions('1.0.1+build5', '1.0.0')).toBe(1)
    expect(compareVersions('v0.2', '0.1.9')).toBe(1)
  })

  it('returns -1 when the left side is older', () => {
    expect(compareVersions('1.2.3', '1.2.4')).toBe(-1)
    expect(compareVersions('2.0.0', '10.0.0')).toBe(-1)
  })
})
