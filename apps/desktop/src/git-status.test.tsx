import { register, resolve } from '@rabjs/react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { GitStatusBadge } from './app'
import { GitService } from './services/git/git.service'

describe('git status badge', () => {
  let root: Root | undefined
  let host: HTMLDivElement | undefined

  afterEach(() => {
    act(() => {
      root?.unmount()
    })
    host?.remove()
    root = undefined
    host = undefined
    const git = resolve(GitService)
    git.busy = false
    git.surface = 'unavailable'
    git.behind = 0
    git.ahead = 0
    git.branch = ''
    git.conflicts = []
    git.output = 'Git is not available in the browser'
  })

  it('shows pull required when a ready surface is behind, and syncing when busy', async () => {
    register(GitService)
    const git = resolve(GitService)
    git.surface = 'ready'
    git.behind = 2
    git.ahead = 0
    git.branch = 'main'
    git.conflicts = []
    git.output = ''
    git.busy = false
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => {
      root?.render(<GitStatusBadge />)
    })
    const badge = () => host?.querySelector('[data-testid="git-status-badge"]')
    expect(badge()?.textContent).toBe('pull required')
    await act(async () => {
      git.busy = true
    })
    expect(badge()?.textContent).toBe('syncing')
  })
})
