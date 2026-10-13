import { observer, register, resolve, useService } from '@rabjs/react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { UpdateBanner } from '../app'
import { GitService, SettingsService, UpdateService } from './panels.service'
import { VaultService } from './vault.service'

describe('browser panels', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('boots without calling the API and keeps updates idle', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    register(VaultService)
    register(SettingsService)
    register(UpdateService)
    register(GitService)
    await resolve(SettingsService).load()
    await resolve(SettingsService).save()
    const updates = resolve(UpdateService)
    await updates.check()
    await updates.download()
    await updates.confirm()
    await updates.dismiss()
    const git = resolve(GitService)
    expect(git.output).toBe('Git is not available in the browser')
    await git.refresh()
    await git.init()
    await git.commit()
    await git.pull()
    await git.push()
    await git.keepSide('note', 'ours')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(updates.phase).toBe('idle')
    expect(updates.error).toBe('')
    expect(git.output).toBe('Git is not available in the browser')
    expect(resolve(SettingsService).form.embedding.endpoint).toBe('')
    expect(resolve(SettingsService).notice).toBe('')
  })

  it('hides the update banner while idle', async () => {
    register(UpdateService)
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const View = observer(function View() {
      useService(UpdateService)
      return <UpdateBanner />
    })
    await act(async () => {
      root.render(<View />)
    })
    expect(host.querySelector('[data-testid="update-banner"]')).toBeNull()
    root.unmount()
    host.remove()
  })
})
