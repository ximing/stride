import { register, resolve } from '@rabjs/react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { App } from '../app'
import { ChatService, GitService, SettingsService, UpdateService } from './panels.service'
import { VaultService } from './vault.service'

function useMemoryFixture() {
  window.history.replaceState(null, '', '/?fixture=memory')
}

function noteTitles(host: HTMLElement): string[] {
  return [...host.querySelectorAll('[data-testid="note-link"]')].map((node) => node.textContent ?? '')
}

describe('vault open and new', () => {
  afterEach(() => {
    window.history.replaceState(null, '', '/')
    vi.unstubAllGlobals()
  })

  it('creates a memory vault without the directory picker and lists seed types', async () => {
    useMemoryFixture()
    const picker = vi.fn()
    vi.stubGlobal('showDirectoryPicker', picker)
    register(VaultService)
    register(GitService)
    register(SettingsService)
    register(ChatService)
    register(UpdateService)
    const vault = resolve(VaultService)
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => {
      root.render(<App />)
    })

    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="new-vault"]')!.click()
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 0))
    })

    expect(picker).not.toHaveBeenCalled()
    expect(vault.phase).toBe('ready')
    expect(vault.vaultPath).toBe('memory-vault')
    const types = [...host.querySelectorAll<HTMLElement>('[data-testid="type-link"]')].map((node) => node.dataset.type)
    expect(types).toEqual(['Note', 'Project', 'Person'])
    expect(noteTitles(host)).not.toEqual(expect.arrayContaining(['Note', 'Project', 'Person']))
    expect(noteTitles(host)).toEqual([])

    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-type="Project"]')!.click()
    })
    expect(vault.listFilter).toBe('Project')
    expect(noteTitles(host)).toEqual([])

    root.unmount()
    host.remove()
    vault.cancelPending()
  })

  it('opens a memory vault without the picker and without seed files', async () => {
    useMemoryFixture()
    const picker = vi.fn()
    vi.stubGlobal('showDirectoryPicker', picker)
    register(VaultService)
    register(GitService)
    register(SettingsService)
    register(ChatService)
    register(UpdateService)
    const vault = resolve(VaultService)
    vault.phase = 'chooser'
    vault.notes = []
    vault.error = ''
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => {
      root.render(<App />)
    })
    expect(host.querySelector('[data-testid="open-vault"]')).not.toBeNull()

    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="open-vault"]')!.click()
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 0))
    })

    expect(picker).not.toHaveBeenCalled()
    expect(vault.phase).toBe('ready')
    expect(await vault.fs!.stat('note.stride.json')).toBeNull()
    expect(await vault.fs!.stat('project.stride.json')).toBeNull()
    expect(await vault.fs!.stat('person.stride.json')).toBeNull()
    expect(host.querySelector('[data-testid="type-link"]')).toBeNull()
    expect(noteTitles(host)).toEqual([])

    root.unmount()
    host.remove()
    vault.cancelPending()
  })
})
