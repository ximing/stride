// T7.3: This Vault settings section — per-vault zoom / density / git setup
// preference, persisted to .stride/vault.json through VaultService.

globalThis.IS_REACT_ACT_ENVIRONMENT = true

import { register, resolve } from '@rabjs/react'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FolderService } from '../../../services/vault/folder.service'
import { STAGE_ZOOM_VAR } from '../../../services/layout/stage-zoom'
import { VaultService } from '../../../services/vault/vault.service'
import { VaultSection } from './vault'

function useMemoryFixture() {
  window.history.replaceState(null, '', '/?fixture=memory')
}

function setControlValue(element: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setter?.call(element, value)
  element.dispatchEvent(new Event('input', { bubbles: true }))
  element.dispatchEvent(new Event('change', { bubbles: true }))
}

describe('T7.3 This Vault settings section', () => {
  let host: HTMLDivElement | null = null
  let root: Root | null = null

  beforeEach(() => {
    register(VaultService)
    register(FolderService)
  })

  afterEach(() => {
    act(() => {
      root?.unmount()
    })
    host?.remove()
    root = null
    host = null
    window.history.replaceState(null, '', '/')
    document.documentElement.style.removeProperty(STAGE_ZOOM_VAR)
    const vault = resolve(VaultService)
    vault.cancelPending()
    void vault.setZoom(1)
    void vault.setViewMode('comfortable')
    void vault.setGitSetupPreference('undecided')
    void vault.setRenameFromHeading(true)
  })

  async function mount(component: ReactElement) {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => {
      root?.render(component)
    })
    return host
  }

  async function openVault() {
    useMemoryFixture()
    const vault = resolve(VaultService)
    await vault.restoreOpened()
    await act(async () => {
      await vault.openFromDraft()
    })
    expect(vault.phase).toBe('ready')
    return vault
  }

  it('shows a placeholder while no vault is open', async () => {
    const vault = resolve(VaultService)
    useMemoryFixture()
    await vault.restoreOpened()
    expect(vault.phase).toBe('chooser')
    const mounted = await mount(<VaultSection />)
    expect(mounted.querySelector('[data-testid="settings-section-vault"]')).not.toBeNull()
    expect(mounted.querySelector('[data-testid="vault-settings-empty"]')).not.toBeNull()
    expect(mounted.textContent).toContain('Open a vault to configure these settings.')
    expect(mounted.querySelector('[data-testid="vault-zoom"]')).toBeNull()
    expect(mounted.querySelector('[data-testid="settings-rename-from-heading"]')).toBeNull()
  })

  it('zoom applies to the stage immediately and persists to vault.json', async () => {
    const vault = await openVault()
    const mounted = await mount(<VaultSection />)
    const input = mounted.querySelector<HTMLInputElement>('[data-testid="vault-zoom"]')!
    expect(input.value).toBe('1')

    await act(async () => {
      setControlValue(input, '1.2')
    })
    expect(vault.zoom).toBe(1.2)
    expect(document.documentElement.style.getPropertyValue(STAGE_ZOOM_VAR)).toBe('1.2')
    expect(mounted.querySelector('[data-testid="vault-zoom-error"]')).toBeNull()
    const marker = await vault.fs!.readText('.stride/vault.json')
    expect(marker).toContain('"zoom": 1.2')
    // The merge keeps the vault marker's own fields.
    expect(marker).toContain('"kind": "stride-vault"')

    // Out-of-range input is rejected in place and never touches state or disk.
    await act(async () => {
      setControlValue(input, '3')
    })
    expect(mounted.querySelector('[data-testid="vault-zoom-error"]')).not.toBeNull()
    expect(vault.zoom).toBe(1.2)
    expect(await vault.fs!.readText('.stride/vault.json')).toContain('"zoom": 1.2')

    // Back to the default clears the CSS variable.
    await act(async () => {
      setControlValue(input, '1')
    })
    expect(vault.zoom).toBe(1)
    expect(document.documentElement.style.getPropertyValue(STAGE_ZOOM_VAR)).toBe('')
  })

  it('zoom set before opening a vault survives the vault open read', async () => {
    useMemoryFixture()
    const vault = resolve(VaultService)
    await vault.restoreOpened()
    await act(async () => {
      await vault.openFromDraft()
    })
    await act(async () => {
      await vault.setZoom(1.4)
    })
    expect(document.documentElement.style.getPropertyValue(STAGE_ZOOM_VAR)).toBe('1.4')

    // Reopening the same vault re-reads .stride/vault.json and re-applies.
    await act(async () => {
      await vault.reopenForSettings()
    })
    expect(vault.zoom).toBe(1.4)
    expect(document.documentElement.style.getPropertyValue(STAGE_ZOOM_VAR)).toBe('1.4')
  })

  it('view mode switches density and persists', async () => {
    const vault = await openVault()
    const mounted = await mount(<VaultSection />)
    const comfortable = mounted.querySelector<HTMLButtonElement>('[data-testid="vault-view-mode-comfortable"]')!
    const compact = mounted.querySelector<HTMLButtonElement>('[data-testid="vault-view-mode-compact"]')!
    expect(comfortable.getAttribute('aria-pressed')).toBe('true')

    await act(async () => {
      compact.click()
    })
    expect(vault.viewMode).toBe('compact')
    expect(compact.getAttribute('aria-pressed')).toBe('true')
    expect(await vault.fs!.readText('.stride/vault.json')).toContain('"viewMode": "compact"')
  })

  it('git setup preference is a three-way radio that persists the choice', async () => {
    const vault = await openVault()
    const mounted = await mount(<VaultSection />)
    const undecided = mounted.querySelector<HTMLInputElement>('[data-testid="vault-git-setup-undecided"]')!
    const enabled = mounted.querySelector<HTMLInputElement>('[data-testid="vault-git-setup-enabled"]')!
    const disabled = mounted.querySelector<HTMLInputElement>('[data-testid="vault-git-setup-disabled"]')!
    expect(undecided.checked).toBe(true)

    await act(async () => {
      enabled.click()
    })
    expect(vault.gitSetupPreference).toBe('enabled')
    expect(await vault.fs!.readText('.stride/vault.json')).toContain('"gitSetupPreference": "enabled"')

    await act(async () => {
      disabled.click()
    })
    expect(vault.gitSetupPreference).toBe('disabled')
    const marker = await vault.fs!.readText('.stride/vault.json')
    expect(marker).toContain('"gitSetupPreference": "disabled"')
    expect(marker).toContain('"kind": "stride-vault"')
  })

  it('rename-from-heading writes .stride/vault.json', async () => {
    const vault = await openVault()
    const mounted = await mount(<VaultSection />)
    const toggle = mounted.querySelector<HTMLInputElement>('[data-testid="settings-rename-from-heading"]')!
    expect(toggle.checked).toBe(true)
    expect(mounted.textContent).toContain('Rename the note file from its first heading (H1)')

    await act(async () => {
      toggle.click()
    })
    expect(vault.renameFromHeading).toBe(false)
    const marker = await vault.fs!.readText('.stride/vault.json')
    expect(marker).toContain('"renameFromHeading": false')
    expect(marker).toContain('"kind": "stride-vault"')
  })
})
