import { describe, expect, it } from 'vitest'
import { gitSurface } from './git-surface.ts'

describe('gitSurface', () => {
  it('lets a missing backend win over the switch and over needs-init', () => {
    expect(gitSurface({ backendAvailable: false, gitEnabled: false, isRepo: false, broadBlocked: true })).toBe('unavailable')
    expect(gitSurface({ backendAvailable: false, gitEnabled: true, isRepo: false, broadBlocked: false })).toBe('unavailable')
    expect(gitSurface({ backendAvailable: false, gitEnabled: true, isRepo: true, broadBlocked: false })).toBe('unavailable')
  })

  it('turns Git off only when a backend exists', () => {
    expect(gitSurface({ backendAvailable: true, gitEnabled: false, isRepo: true, broadBlocked: true })).toBe('disabled')
  })

  it('reports an existing repository before a broad-root block', () => {
    expect(gitSurface({ backendAvailable: true, gitEnabled: true, isRepo: true, broadBlocked: true })).toBe('ready')
  })

  it('blocks a broad root that is not a repository', () => {
    expect(gitSurface({ backendAvailable: true, gitEnabled: true, isRepo: false, broadBlocked: true })).toBe('blocked')
  })

  it('asks for init when Git can run and the folder is not a repo', () => {
    expect(gitSurface({ backendAvailable: true, gitEnabled: true, isRepo: false, broadBlocked: false })).toBe('needs-init')
  })
})
