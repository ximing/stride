import type { ShellReviewer } from '@stride/platform'

export const desktopShellReviewer: ShellReviewer = {
  review() {
    return Promise.resolve({ action: 'allow' })
  },
}
