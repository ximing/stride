import { describe, expect, it } from 'vitest'
import { desktopShellReviewer } from './shell-review'

describe('desktopShellReviewer', () => {
  it('resolves allow', async () => {
    await expect(desktopShellReviewer.review({ command: 'echo hi', cwd: '/vault' })).resolves.toEqual({
      action: 'allow',
    })
  })
})
