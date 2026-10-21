// T7.3 follow-up: pins that Mod+, opens the settings page from the Chooser
// (no vault open), not just from the Workspace. The shortcut dispatcher lives
// in the CommandPalette's window-capture listener, and the palette mounts at
// the App level above both phases — so the chord must fire in either phase.

globalThis.IS_REACT_ACT_ENVIRONMENT = true

import { register, resolve } from '@rabjs/react'
import { MemorySecretsStore } from '@stride/platform'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { App } from './app'
import { FolderService } from './services/vault/folder.service'
import { LayoutService } from './services/layout/layout.service'
import { ListFilterService } from './services/search/list-filter.service'
import { NoteListService } from './services/notes/note-list.service'
import { ChatService } from './services/chat/chat.service'
import { GitService } from './services/git/git.service'
import { resetSecretsStore, setSecretsStore, SettingsService } from './services/settings/settings.service'
import { UpdateService } from './services/update/update.service'
import { SettingsPageService } from './services/settings/settings-page.service'
import { TabsService } from './services/notes/tabs.service'
import { VAULT_REGISTRY_KEY, VaultService } from './services/vault/vault.service'
import { ViewsService } from './services/views/views.service'

describe('settings shortcut from the chooser', () => {
  let host: HTMLDivElement | null = null
  let root: Root | null = null

  afterEach(() => {
    act(() => {
      root?.unmount()
    })
    host?.remove()
    root = null
    host = null
    window.history.replaceState(null, '', '/')
    localStorage.removeItem(VAULT_REGISTRY_KEY)
    resetSecretsStore()
    resolve(SettingsPageService).close()
    resolve(VaultService).cancelPending()
  })

  it('Mod+, opens the settings page while the Chooser is mounted', async () => {
    window.history.replaceState(null, '', '/?fixture=memory')
    localStorage.removeItem(VAULT_REGISTRY_KEY)
    register(VaultService)
    register(ViewsService)
    register(TabsService)
    register(ListFilterService)
    register(NoteListService)
    register(LayoutService)
    register(FolderService)
    register(GitService)
    register(SettingsService)
    register(ChatService)
    register(UpdateService)
    setSecretsStore(new MemorySecretsStore())

    const vault = resolve(VaultService)
    await vault.restoreOpened()
    expect(vault.phase).toBe('chooser')

    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => {
      root?.render(<App />)
    })
    expect(document.querySelector('.chooser')).not.toBeNull()

    const settings = resolve(SettingsPageService)
    expect(settings.open).toBe(false)
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: ',', metaKey: true, bubbles: true, cancelable: true }))
    })
    expect(settings.open).toBe(true)
    expect(document.querySelector('[data-testid="settings-page"]')).not.toBeNull()
  })
})
