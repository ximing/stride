import { register, resolve } from '@rabjs/react'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
import { createNote, type StrideNote } from '@stride/core/note'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CommandPalette } from '../../ui/overlays/command-palette'
import { buildPaletteItems, paletteItemTitle } from './command-palette'
import { CommandPaletteService } from './command-palette.service'
import { CommandService } from './command.service'
import { formatShortcut, shortcutToKeyEventInit } from './commands'
import { LayoutService } from '../layout/layout.service'
import { ChatService } from '../chat/chat.service'
import { QuickOpenService } from '../search/quick-open.service'
import { SearchPanelService } from '../search/search-panel.service'
import { TabsService } from '../notes/tabs.service'
import { VaultService } from '../vault/vault.service'

function note(id: string, title: string, type = 'note'): StrideNote {
  return createNote(id, title, type)
}

function press(init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  window.dispatchEvent(event)
  return event
}

describe('command palette items', () => {
  it('builds commands, expanded type instances, note matches, and the AI entry', () => {
    const commands = resolve(CommandService).commands
    const template = commands.find((command) => command.id === 'file.newInstance')!
    const items = buildPaletteItems({
      commands,
      query: '',
      isRunnable: () => true,
      notes: [note('a', 'Alpha'), note('b', 'Beta')],
      typeTitles: ['项目'],
    })
    const ids = items.filter((item) => item.kind === 'command').map((item) => item.command.id)
    expect(ids).not.toContain('file.newInstance')
    expect(ids).toEqual(commands.filter((command) => command.id !== 'file.newInstance').map((command) => command.id))
    const instance = items.find((item) => item.kind === 'instance')
    expect(instance && paletteItemTitle(instance)).toBe('New 项目')
    const quickOpen = items.find((item) => item.kind === 'command' && item.command.id === 'nav.quickOpen')
    expect(quickOpen && paletteItemTitle(quickOpen)).toBe('Quick Open')
    expect(items.filter((item) => item.kind === 'note').map((item) => item.title)).toEqual(['Alpha', 'Beta'])
    const ai = items.at(-1)!
    expect(ai.kind).toBe('ai')
    expect(paletteItemTitle(ai)).toBe('Ask AI…')

    const queried = buildPaletteItems({
      commands,
      query: '项目',
      isRunnable: () => true,
      notes: [note('a', 'Alpha')],
      typeTitles: ['项目'],
    })
    expect(queried.some((item) => item.kind === 'instance' && item.typeTitle === '项目')).toBe(true)
    expect(queried.filter((item) => item.kind === 'note')).toEqual([])
    expect(paletteItemTitle(queried.at(-1)!)).toBe('Ask AI about “项目”')

    // No types at all: the template stays visible but disabled.
    const typeless = buildPaletteItems({
      commands,
      query: '',
      isRunnable: (command) => command.id === template.id,
      notes: [],
      typeTitles: [],
    })
    const entry = typeless.find((item) => item.kind === 'command' && item.command.id === 'file.newInstance')
    expect(entry).toBeDefined()
    expect(entry && entry.kind === 'command' && entry.enabled).toBe(false)
  })
})

describe('command service', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('gates commands on enabledWhen conditions and handler availability', () => {
    register(VaultService)
    const vault = resolve(VaultService)
    const commands = resolve(CommandService)
    vault.phase = 'chooser'
    vault.notes = []
    vault.activeId = ''

    const newNote = commands.commands.find((command) => command.id === 'file.newNote')!
    expect(commands.isEnabled(newNote)).toBe(false)
    expect(commands.isRunnable(newNote)).toBe(false)

    vault.phase = 'ready'
    expect(commands.isRunnable('file.newNote')).toBe(true)

    const find = commands.commands.find((command) => command.id === 'edit.find')!
    vault.notes = [note('a', 'Alpha')]
    vault.activeId = 'a'
    expect(commands.isEnabled(find)).toBe(true)
    // No handler while the editor find bar is not mounted.
    expect(commands.isRunnable(find)).toBe(false)
    const unregister = commands.registerHandler('edit.find', { run: () => {} })
    expect(commands.isRunnable(find)).toBe(true)
    unregister()
    expect(commands.isRunnable(find)).toBe(false)

    // gitReady needs GitService, which this file never registers.
    expect(commands.isEnabled({ id: 'x', title: 'X', section: 'View', enabledWhen: 'gitReady' })).toBe(false)
  })

  it('dispatchKeydown matches the manifest, respects enabledWhen, and swallows the event only when it runs', () => {
    register(VaultService)
    register(QuickOpenService)
    const vault = resolve(VaultService)
    const quick = resolve(QuickOpenService)
    const commands = resolve(CommandService)
    vault.phase = 'chooser'
    quick.close()

    // Disabled (vault not ready): untouched, so the browser default survives.
    const blocked = new KeyboardEvent('keydown', { key: 'n', metaKey: true, cancelable: true })
    expect(commands.dispatchKeydown(blocked)).toBe(false)
    expect(blocked.defaultPrevented).toBe(false)

    // Quick open is vault-scoped too: in the chooser its overlay is not even
    // mounted, so the shortcut must not fire (T6.3 audit gap fix).
    const chooserQuickOpen = new KeyboardEvent('keydown', { key: 'p', metaKey: true, cancelable: true })
    expect(commands.dispatchKeydown(chooserQuickOpen)).toBe(false)
    expect(chooserQuickOpen.defaultPrevented).toBe(false)
    expect(quick.open).toBe(false)

    vault.phase = 'ready'
    const open = new KeyboardEvent('keydown', { key: 'p', metaKey: true, cancelable: true })
    expect(commands.dispatchKeydown(open)).toBe(true)
    expect(open.defaultPrevented).toBe(true)
    expect(quick.open).toBe(true)
    quick.close()

    // Already handled events are left alone, so stacked overlay listeners do not double-run.
    const handled = new KeyboardEvent('keydown', { key: 'p', metaKey: true, cancelable: true })
    handled.preventDefault()
    expect(commands.dispatchKeydown(handled)).toBe(false)
    expect(quick.open).toBe(false)
  })
})

describe('command palette', () => {
  let host: HTMLDivElement | null = null
  let root: Root | null = null

  afterEach(() => {
    resolve(CommandPaletteService).close()
    resolve(QuickOpenService).close()
    resolve(SearchPanelService).close()
    root?.unmount()
    host?.remove()
    root = null
    host = null
    vi.restoreAllMocks()
  })

  async function mount(notes: StrideNote[], phase: 'chooser' | 'ready' = 'ready') {
    register(VaultService)
    register(QuickOpenService)
    register(SearchPanelService)
    register(ChatService)
    const vault = resolve(VaultService)
    vault.phase = phase
    vault.notes = notes
    vault.activeId = notes.find((item) => item.type !== 'Type')?.id ?? ''
    vault.listFilter = 'all'
    resolve(LayoutService).setRightPanelTab('properties')
    const palette = resolve(CommandPaletteService)
    palette.close()
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => {
      root?.render(<CommandPalette />)
    })
    return { vault, palette }
  }

  it('opens on Mod+K, filters commands and notes, and closes on Escape', async () => {
    await mount([note('alpha', 'Alpha'), note('beta', 'Beta')])
    expect(host?.querySelector('[data-testid="command-palette"]')).toBeNull()

    let openEvent!: KeyboardEvent
    await act(async () => {
      openEvent = press({ key: 'k', metaKey: true })
    })
    expect(openEvent.defaultPrevented).toBe(true)
    const dialog = host?.querySelector('[data-testid="command-palette"]')
    expect(dialog?.getAttribute('role')).toBe('dialog')
    expect(document.activeElement).toBe(host?.querySelector('[data-testid="command-palette-input"]'))
    expect(host?.textContent).toContain('Commands')
    expect(host?.textContent).toContain('Notes')
    expect(host?.textContent).toContain('AI')

    // Commands render their manifest title as visible text, with the shortcut right-aligned.
    const quickOpenItem = host?.querySelector('[data-command-id="nav.quickOpen"]')
    expect(quickOpenItem?.querySelector('.command-item-title')?.textContent).toBe('Quick Open')
    expect(quickOpenItem?.querySelector('kbd')?.textContent).toBe(formatShortcut('Mod+P'))
    const commandItems = [...(host?.querySelectorAll('[data-testid="command-item"]') ?? [])]
    expect(commandItems.length).toBeGreaterThan(0)
    for (const item of commandItems) {
      expect(item.querySelector('.command-item-title')?.textContent?.trim().length).toBeGreaterThan(0)
    }
    expect(host?.textContent).toContain('New Note')
    expect(host?.textContent).toContain('Search Vault')

    await act(async () => {
      resolve(CommandPaletteService).setQuery('beta')
    })
    expect(host?.querySelector('[data-command-id="nav.quickOpen"]')).toBeNull()
    const noteItems = [...(host?.querySelectorAll('[data-testid="command-palette-note"]') ?? [])]
    expect(noteItems.map((item) => item.getAttribute('data-note-id'))).toEqual(['beta'])
    expect(host?.textContent).toContain('Ask AI about “beta”')

    await act(async () => {
      press({ key: 'Escape' })
    })
    expect(host?.querySelector('[data-testid="command-palette"]')).toBeNull()
  })

  it('executes the selected command on Enter and jumps to notes', async () => {
    const { vault, palette } = await mount([note('alpha', 'Alpha'), note('beta', 'Beta')])
    const select = vi.spyOn(vault, 'select')
    await act(async () => {
      palette.show()
      palette.setQuery('quick open')
    })
    await act(async () => {
      press({ key: 'Enter' })
    })
    expect(resolve(QuickOpenService).open).toBe(true)
    expect(resolve(CommandPaletteService).open).toBe(false)
    resolve(QuickOpenService).close()

    await act(async () => {
      palette.show()
      palette.setQuery('beta')
    })
    // The note match is the first item (no command matches "beta").
    await act(async () => {
      press({ key: 'Enter' })
    })
    expect(select).toHaveBeenCalledWith('beta')
    expect(vault.activeId).toBe('beta')
    expect(palette.open).toBe(false)
  })

  it('greys out disabled commands and refuses to run them', async () => {
    const { vault, palette } = await mount([note('alpha', 'Alpha')], 'chooser')
    const create = vi.spyOn(vault, 'createNote')
    await act(async () => {
      palette.show()
      palette.setQuery('new note')
    })
    const item = host?.querySelector('[data-command-id="file.newNote"]') as HTMLButtonElement
    expect(item).not.toBeNull()
    expect(item.disabled).toBe(true)
    await act(async () => {
      item.click()
    })
    expect(create).not.toHaveBeenCalled()
    expect(palette.open).toBe(true)
  })

  it('expands new-instance commands per visible type and forwards to createInstance', async () => {
    const { vault, palette } = await mount([note('alpha', 'Alpha'), note('type', '项目', 'Type')])
    const createInstance = vi.spyOn(vault, 'createInstance').mockResolvedValue(undefined)
    await act(async () => {
      palette.show()
    })
    const item = host?.querySelector('[data-command-id="file.newInstance:项目"]') as HTMLButtonElement
    expect(item).not.toBeNull()
    expect(item.querySelector('.command-item-title')?.textContent).toBe('New 项目')
    expect(item.disabled).toBe(false)
    await act(async () => {
      item.click()
    })
    expect(createInstance).toHaveBeenCalledWith('项目')
    expect(palette.open).toBe(false)
  })

  it('hands the query to the chat panel as a draft via the AI entry', async () => {
    const { palette } = await mount([note('alpha', 'Alpha')])
    await act(async () => {
      palette.show()
      palette.setQuery('总结本周')
    })
    const ai = host?.querySelector('[data-testid="command-palette-ai"]') as HTMLButtonElement
    expect(ai.textContent).toContain('Ask AI about “总结本周”')
    await act(async () => {
      ai.click()
    })
    expect(resolve(LayoutService).rightPanelTab).toBe('chat')
    expect(resolve(LayoutService).rightPanelCollapsed).toBe(false)
    expect(resolve(ChatService).draft).toBe('总结本周')
    expect(palette.open).toBe(false)
  })

  it('keeps overlays mutually exclusive: opening one closes the others', async () => {
    await mount([note('alpha', 'Alpha')])
    const palette = resolve(CommandPaletteService)
    const quick = resolve(QuickOpenService)
    const search = resolve(SearchPanelService)

    // Palette → quick open: a Mod+P with the palette open switches overlays
    // instead of stacking two dialogs.
    await act(async () => {
      palette.show()
      press({ key: 'p', metaKey: true })
    })
    expect(quick.open).toBe(true)
    expect(palette.open).toBe(false)

    // Quick open → search panel.
    await act(async () => {
      press({ key: 'f', metaKey: true, shiftKey: true })
    })
    expect(search.open).toBe(true)
    expect(quick.open).toBe(false)

    // Search panel → palette via Mod+K (toggle opens because it was closed).
    await act(async () => {
      press({ key: 'k', metaKey: true })
    })
    expect(palette.open).toBe(true)
    expect(search.open).toBe(false)
  })

  it('keeps dispatcher, palette, and manifest on one source of truth', async () => {
    const { palette } = await mount([note('alpha', 'Alpha'), note('beta', 'Beta'), note('gamma', 'Gamma')])
    const commands = resolve(CommandService)
    await act(async () => {
      palette.show()
    })

    // nav.goBack/nav.goForward are gated on the active tab's history, so give it
    // a past and a future: a → b → c, then one step back.
    const tabs = resolve(TabsService)
    tabs.openNote('alpha')
    tabs.followLink('beta')
    tabs.followLink('gamma')
    tabs.goBack()
    expect(tabs.canGoBack).toBe(true)
    expect(tabs.canGoForward).toBe(true)

    // Palette ⇐ manifest: every manifest command renders as a palette item
    // (file.newInstance expands into per-type entries when types exist),
    // showing its manifest title as text.
    const domItems = [...(host?.querySelectorAll('[data-command-id]') ?? [])]
    const domIds = domItems.map((item) => item.getAttribute('data-command-id'))
    for (const command of commands.commands) {
      if (command.id === 'file.newInstance') continue
      expect(domIds).toContain(command.id)
      const rendered = domItems.find((item) => item.getAttribute('data-command-id') === command.id)
      expect(rendered?.querySelector('.command-item-title')?.textContent).toBe(command.title)
    }

    // Dispatcher ⇐ manifest: every manifest shortcut resolves back to its own command.
    const ran: string[] = []
    const unregisterFind = commands.registerHandler('edit.find', { run: () => ran.push('edit.find') })
    const execute = vi.spyOn(commands, 'execute').mockImplementation((id: string) => {
      ran.push(id)
      return true
    })
    try {
      for (const command of commands.commands) {
        if (!command.shortcut) continue
        const init = shortcutToKeyEventInit(command.shortcut)!
        const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
        window.dispatchEvent(event)
        expect(event.defaultPrevented).toBe(true)
        expect(ran.at(-1)).toBe(command.id)
      }
    } finally {
      execute.mockRestore()
      unregisterFind()
    }
  })
})
