import { register, resolve } from '@rabjs/react'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import manifest from '../../appCommandManifest.json'
import { CommandService } from '../../services/command.service'
import { formatShortcut, parseAppCommandManifest } from '../../services/commands'
import { QuickOpenService } from '../../services/quick-open.service'
import { SETTINGS_SECTION_IDS, SettingsPageService } from '../../services/settings-page.service'
import { VaultService } from '../../services/vault.service'
import { SETTINGS_SECTIONS } from './sections'
import { SettingsPage } from './settings-page'

const commands = parseAppCommandManifest(manifest)

function press(init: KeyboardEventInit, target: Window | Document = window): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  target.dispatchEvent(event)
  return event
}

describe('settings page overlay', () => {
  let host: HTMLDivElement | null = null
  let root: Root | null = null
  let settingsTrigger: HTMLButtonElement | null = null

  afterEach(() => {
    resolve(SettingsPageService).close()
    resolve(QuickOpenService).close()
    root?.unmount()
    host?.remove()
    settingsTrigger?.remove()
    root = null
    host = null
    settingsTrigger = null
  })

  async function mount() {
    register(VaultService)
    register(QuickOpenService)
    const service = resolve(SettingsPageService)
    service.close()
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => {
      root?.render(<SettingsPage />)
    })
    return service
  }

  it('stays hidden while closed and opens with the appearance section active', async () => {
    const service = await mount()
    expect(document.querySelector('[data-testid="settings-page"]')).toBeNull()
    await act(async () => {
      service.show()
    })
    const page = document.querySelector('[data-testid="settings-page"]')
    expect(page).not.toBeNull()
    expect(document.querySelector('[data-testid="settings-section-appearance"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="settings-nav-appearance"]')?.getAttribute('aria-current')).toBe('page')
  })

  it('renders the eight sections in fixed order and switches between them', async () => {
    const service = await mount()
    await act(async () => {
      service.show()
    })
    const navIds = [...document.querySelectorAll('.settings-nav-item')].map((item) =>
      item.getAttribute('data-testid')?.replace('settings-nav-', ''),
    )
    expect(navIds).toEqual([...SETTINGS_SECTION_IDS])
    expect(SETTINGS_SECTIONS.map((section) => section.id)).toEqual([...SETTINGS_SECTION_IDS])

    const shortcuts = document.querySelector('[data-testid="settings-nav-shortcuts"]') as HTMLButtonElement
    await act(async () => {
      shortcuts.click()
    })
    expect(service.section).toBe('shortcuts')
    expect(document.querySelector('[data-testid="settings-section-shortcuts"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="settings-section-appearance"]')).toBeNull()
  })

  it('closes on Escape and on the close button', async () => {
    const service = await mount()
    await act(async () => {
      service.show()
    })
    await act(async () => {
      // Radix listens on document; the page keeps overlay-local Esc to itself.
      press({ key: 'Escape' }, document)
    })
    expect(service.open).toBe(false)
    expect(document.querySelector('[data-testid="settings-page"]')).toBeNull()

    await act(async () => {
      service.show()
    })
    const close = document.querySelector('[data-testid="settings-close"]') as HTMLButtonElement
    await act(async () => {
      close.click()
    })
    expect(service.open).toBe(false)
  })

  it('restores focus to the status bar settings button when closed', async () => {
    const service = await mount()
    settingsTrigger = document.createElement('button')
    settingsTrigger.type = 'button'
    settingsTrigger.dataset.testid = 'statusbar-settings'
    document.body.appendChild(settingsTrigger)
    settingsTrigger.focus()

    await act(async () => {
      service.show()
    })
    const close = document.querySelector('[data-testid="settings-close"]') as HTMLButtonElement
    await act(async () => {
      close.click()
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(service.open).toBe(false)
    expect(document.activeElement).toBe(settingsTrigger)
  })

  it('opens via the manifest command id and its Mod+, chord', async () => {
    const service = await mount()
    const commandService = resolve(CommandService)
    const command = commands.find((item) => item.id === 'view.tab.settings')!
    expect(command.shortcut).toBe('Mod+,')
    expect(commandService.isRunnable(command)).toBe(true)

    await act(async () => {
      commandService.execute('view.tab.settings')
    })
    expect(service.open).toBe(true)

    await act(async () => {
      service.close()
    })
    await act(async () => {
      const event = press({ key: ',', metaKey: true })
      expect(commandService.dispatchKeydown(event)).toBe(true)
    })
    expect(service.open).toBe(true)
  })

  it('joins the overlay cohort: opening it closes quick open', async () => {
    const service = await mount()
    const quick = resolve(QuickOpenService)
    await act(async () => {
      quick.show()
    })
    expect(quick.open).toBe(true)
    await act(async () => {
      service.show()
    })
    expect(quick.open).toBe(false)
    expect(service.open).toBe(true)
  })

  it('lists every manifest command grouped by section with formatted shortcuts', async () => {
    const service = await mount()
    await act(async () => {
      service.show('shortcuts')
    })
    const groups = [...document.querySelectorAll('.settings-shortcut-group')]
    const manifestSections = [...new Set(commands.map((command) => command.section))]
    expect(groups.map((group) => group.getAttribute('data-section'))).toEqual(manifestSections)

    const rows = [...document.querySelectorAll('.settings-shortcut-row')]
    expect(rows.map((row) => row.getAttribute('data-command-id'))).toEqual(commands.map((command) => command.id))
    for (const command of commands) {
      const row = document.querySelector(`.settings-shortcut-row[data-command-id="${command.id}"]`)!
      expect(row.querySelector('.settings-shortcut-title')?.textContent).toBe(command.title)
      if (command.shortcut) {
        expect(row.querySelector('kbd')?.textContent).toBe(formatShortcut(command.shortcut))
      } else {
        expect(row.querySelector('.settings-shortcut-none')?.textContent).toBe('—')
      }
    }
  })
})
