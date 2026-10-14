import { describe, expect, it } from 'vitest'
import { syncState } from './sync-state.ts'

describe('syncState', () => {
  it('lets busy win over conflict, error, and behind', () => {
    expect(syncState({ busy: true, conflict: true, behind: 3, error: true })).toBe('syncing')
  })

  it('reports conflict before error and behind', () => {
    expect(syncState({ busy: false, conflict: true, behind: 3, error: true })).toBe('conflict')
  })

  it('reports error before a repo that is behind', () => {
    expect(syncState({ busy: false, conflict: false, behind: 3, error: true })).toBe('error')
  })

  it('requires a pull when the repo is behind', () => {
    expect(syncState({ busy: false, conflict: false, behind: 1, error: false })).toBe('pull_required')
  })

  it('is idle when nothing is pending', () => {
    expect(syncState({ busy: false, conflict: false, behind: 0, error: false })).toBe('idle')
  })
})
