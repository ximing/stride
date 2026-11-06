import { describe, expect, it } from 'vitest'
import { PlatformError } from '@stride/platform'
import { browserShellBackend } from './index.ts'

describe('browser shell', () => {
  it('reports shell as unavailable', async () => {
    const shell = browserShellBackend()
    expect(shell.available).toBe(false)
    try {
      await shell.exec({ command: 'echo hi', cwd: '/vault' })
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(PlatformError)
      expect((error as PlatformError).code).toBe('shell-unavailable')
    }
  })
})
