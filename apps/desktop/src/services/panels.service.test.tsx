import { observer, register, resolve, useService } from '@rabjs/react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { UpdateBanner } from '../app'
import { resetUiHandoff, setUiHandoff, UpdateService } from './panels.service'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

describe('UpdateService confirm', () => {
  afterEach(() => {
    resetUiHandoff()
    vi.unstubAllGlobals()
  })

  it('leaves the ready banner and shows the error when the installed bytes cannot start', async () => {
    const handed: string[] = []
    setUiHandoff(() => { handed.push('exit') })
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'spawn ENOEXEC' }, 400)))
    register(UpdateService)
    const updates = resolve(UpdateService)
    updates.phase = 'ready'
    updates.version = 'v0.2.0'
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
    expect(host.textContent).toContain('Update ready')
    await act(async () => {
      await updates.confirm()
    })
    expect(host.textContent).not.toContain('Update ready')
    expect(host.textContent).toContain('spawn ENOEXEC')
    expect(updates.phase).toBe('available')
    expect(handed).toEqual([])
    root.unmount()
    host.remove()
  })

  it('quits this window only after the server reports the installed app stayed up', async () => {
    const handed: string[] = []
    setUiHandoff(() => { handed.push('exit') })
    vi.stubGlobal('fetch', vi.fn(async () => json({
      phase: 'ready',
      progress: 1,
      selected: { version: 'v0.2.0', assetName: 'stride-0.2.0.bin', assetUrl: 'http://127.0.0.1/stride' },
      version: 'v0.2.0',
      restartRequested: true,
    })))
    register(UpdateService)
    const updates = resolve(UpdateService)
    updates.phase = 'ready'
    await updates.confirm()
    expect(handed).toEqual(['exit'])
    expect(updates.error).toBe('')
    expect(updates.phase).toBe('ready')
  })
})
