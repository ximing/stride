import { describe, expect, it } from 'vitest'
import { PlatformError } from '@stride/platform'
import { browserGitBackend } from './index.ts'

describe('browser git', () => {
  it('reports git as unavailable', async () => {
    const git = browserGitBackend()
    expect(git.available).toBe(false)
    try {
      await git.commit('/repo', 'message')
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(PlatformError)
      expect((error as PlatformError).code).toBe('git-unavailable')
    }
  })
})
