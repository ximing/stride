import { register, resolve } from '@rabjs/react'
import { createNote } from '@stride/core/note'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { commandTitle } from '../../i18n'
import { formatShortcut } from '../../services/commands/commands'
import { TabsService } from '../../services/notes/tabs.service'
import { VaultService } from '../../services/vault/vault.service'
import { TabStrip } from './tab-strip'

describe('TabStrip close hint', () => {
  let host: HTMLDivElement | null = null
  let root: Root | null = null

  afterEach(() => {
    act(() => root?.unmount())
    host?.remove()
    root = null
    host = null
    const tabs = resolve(TabsService)
    tabs.tabs = []
    tabs.activeTabId = ''
    tabs.vaultKey = ''
    const vault = resolve(VaultService)
    vault.phase = 'chooser'
    vault.notes = []
    vault.activeId = ''
    vault.activeVaultId = ''
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  })

  async function renderStrip() {
    register(VaultService)
    const vault = resolve(VaultService)
    const note = createNote('alpha', 'Alpha')
    vault.phase = 'ready'
    vault.notes = [note]
    vault.activeId = note.id
    vault.activeVaultId = ''
    const tabs = resolve(TabsService)
    tabs.vaultKey = ''
    tabs.tabs = [{ id: 't1', noteId: note.id, back: [], forward: [] }]
    tabs.activeTabId = 't1'
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => {
      root?.render(<TabStrip />)
    })
    await act(async () => {
      await new Promise((done) => setTimeout(done, 0))
    })
  }

  function closeLabel(): string | null {
    return host?.querySelector('[data-testid="tab-close"]')?.getAttribute('aria-label') ?? null
  }

  it('shows the manifest close chord in the browser', async () => {
    await renderStrip()
    const name = commandTitle('tab.close', 'Close tab')
    expect(closeLabel()).toBe(`${name} (${formatShortcut('Mod+W')})`)
    expect(host?.querySelector('[data-testid="tab-close"]')?.getAttribute('title')).toBeNull()
  })

  it('omits the close chord on the desktop runtime', async () => {
    ;(window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {}
    await renderStrip()
    const name = commandTitle('tab.close', 'Close tab')
    expect(closeLabel()).toBe(name)
    expect(closeLabel()).not.toContain(formatShortcut('Mod+W'))
    expect(host?.querySelector('[data-testid="tab-close"]')?.getAttribute('title')).toBeNull()
  })
})
