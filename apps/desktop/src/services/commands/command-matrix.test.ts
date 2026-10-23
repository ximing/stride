import { register, resolve } from '@rabjs/react'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
import { createNote, type StrideNote } from '@stride/core/note'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import manifest from '../../appCommandManifest.json'
import { CommandPalette } from '../../ui/overlays/command-palette'
import { CommandService } from './command.service'
import {
  COMMAND_CONDITIONS,
  commandForKeyEvent,
  parseAppCommandManifest,
  parseShortcut,
  shortcutToKeyEventInit,
  type AppCommand,
} from './commands'
import { GitService } from '../git/git.service'
import { NoteListService } from '../notes/note-list.service'
import { QuickOpenService } from '../search/quick-open.service'
import { SearchPanelService } from '../search/search-panel.service'
import { TabsService } from '../notes/tabs.service'
import { VaultService } from '../vault/vault.service'

function note(id: string, title: string): StrideNote {
  return createNote(id, title)
}

const commands = parseAppCommandManifest(manifest)

function chordOf(command: AppCommand): string {
  const parsed = parseShortcut(command.shortcut ?? '')
  if (!parsed) return ''
  return `${parsed.mod ? 'Mod+' : ''}${parsed.alt ? 'Alt+' : ''}${parsed.shift ? 'Shift+' : ''}${parsed.key}`
}

// Chords the TipTap editor keymap binds (StarterKit, Highlight, toolbar labels).
// History owns Mod+Z, Mod+Shift+Z, and Mod+Y. A manifest chord on any of these
// would win on window capture and silently shadow the editor.
const EDITOR_KEYMAP_CHORDS = [
  'Mod+Z',
  'Mod+Shift+Z',
  'Mod+Y',
  'Mod+B',
  'Mod+I',
  'Mod+E',
  'Mod+Alt+2',
  'Mod+Alt+3',
  'Mod+Shift+7',
  'Mod+Shift+8',
  'Mod+Shift+B',
  'Mod+Shift+H',
  'Mod+Shift+S',
  'Mod+Shift+L',
  'Mod+Shift+E',
  'Mod+Shift+R',
  'Mod+Shift+J',
  'Mod+ArrowUp',
  'Mod+ArrowDown',
  'Mod+ArrowLeft',
  'Mod+ArrowRight',
  'Mod+Shift+ArrowUp',
  'Mod+Shift+ArrowDown',
  'Mod+Shift+ArrowLeft',
  'Mod+Shift+ArrowRight',
]

describe('shortcut matrix', () => {
  it('has no duplicate chords and pins first-in-manifest-order as the priority rule', () => {
    const seen = new Map<string, string>()
    for (const command of commands) {
      if (!command.shortcut) continue
      const chord = chordOf(command)
      expect(chord, `${command.id} has a malformed shortcut`).not.toBe('')
      expect(seen.has(chord), `chord "${command.shortcut}" is claimed by both "${seen.get(chord)}" and "${command.id}"`).toBe(false)
      seen.set(chord, command.id)
    }

    // If a duplicate ever is introduced deliberately, the earlier entry wins.
    const dupes: AppCommand[] = [
      { id: 'a.first', title: 'First', section: 'X', shortcut: 'Mod+K' },
      { id: 'b.second', title: 'Second', section: 'X', shortcut: 'Mod+K' },
    ]
    const event = new KeyboardEvent('keydown', { key: 'k', metaKey: true })
    expect(commandForKeyEvent(dupes, event)?.id).toBe('a.first')
  })

  it('requires Mod on every shortcut so typing is never hijacked', () => {
    // Focus semantics: Mod chords are global app commands — they fire while an
    // input, textarea, or the editor has focus. A modifier-less binding would
    // eat keystrokes from text entry, so the manifest forbids it by policy.
    for (const command of commands) {
      if (!command.shortcut) continue
      const parsed = parseShortcut(command.shortcut)!
      expect(parsed.mod, `${command.id} ("${command.shortcut}") must carry Mod`).toBe(true)
    }
  })

  it('never overlaps the editor keymap chords', () => {
    const manifestChords = new Set(commands.filter((command) => command.shortcut).map(chordOf))
    for (const chord of EDITOR_KEYMAP_CHORDS) {
      const parsed = parseShortcut(chord)!
      const normalized = `${parsed.mod ? 'Mod+' : ''}${parsed.alt ? 'Alt+' : ''}${parsed.shift ? 'Shift+' : ''}${parsed.key}`
      expect(manifestChords.has(normalized), `editor chord "${chord}" collides with a manifest command`).toBe(false)
    }
  })

  it('keeps every enabledWhen condition implemented by CommandService', () => {
    register(VaultService)
    register(GitService)
    const vault = resolve(VaultService)
    const service = resolve(CommandService)
    const conditions = (service as unknown as { conditions: Record<string, () => boolean> }).conditions
    expect(new Set(Object.keys(conditions))).toEqual(new Set(COMMAND_CONDITIONS))

    // Behavioral spot-check: with no vault open, every conditioned command is disabled.
    vault.phase = 'chooser'
    vault.notes = []
    vault.activeId = ''
    for (const command of commands) {
      if (!command.enabledWhen) continue
      expect(service.isEnabled(command), `${command.id} gated on ${command.enabledWhen}`).toBe(false)
    }
    // Ungated commands (palette) stay enabled in the chooser.
    for (const command of commands) {
      if (command.enabledWhen) continue
      expect(service.isEnabled(command), command.id).toBe(true)
    }

    const probe = (enabledWhen: string): AppCommand => ({
      id: `probe.${enabledWhen}`,
      title: enabledWhen,
      section: 'X',
      enabledWhen,
    })

    vault.phase = 'ready'
    vault.notes = [note('a', 'Alpha'), note('b', 'Beta'), note('c', 'Gamma')]
    vault.activeId = 'a'
    expect(conditions.vaultReady()).toBe(true)
    expect(service.isEnabled(probe('vaultReady'))).toBe(true)
    expect(conditions.hasActiveNote()).toBe(true)
    expect(service.isEnabled(probe('hasActiveNote'))).toBe(true)

    const git = resolve(GitService)
    expect(conditions.gitReady()).toBe(false)
    git.surface = 'ready'
    expect(conditions.gitReady()).toBe(true)
    expect(service.isEnabled(probe('gitReady'))).toBe(true)

    const tabs = resolve(TabsService)
    tabs.openNote('a')
    tabs.followLink('b')
    tabs.followLink('c')
    tabs.goBack()
    expect(conditions.canGoBack()).toBe(true)
    expect(conditions.canGoForward()).toBe(true)
    expect(service.isEnabled(probe('canGoBack'))).toBe(true)
    expect(service.isEnabled(probe('canGoForward'))).toBe(true)

    const list = resolve(NoteListService)
    list.selectedIds = ['a', 'b']
    expect(conditions.hasListSelection()).toBe(true)
    expect(service.isEnabled(probe('hasListSelection'))).toBe(true)
  })
})

describe('shortcut dispatch matrix', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  // CommandPalette registers app.commandPalette on mount. FindBar is not mounted
  // here: this matrix 不含组件 handler for edit.find. Do not stub it and claim coverage.
  async function mountCommandPalette(): Promise<() => Promise<void>> {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => {
      root.render(createElement(CommandPalette))
    })
    return async () => {
      await act(async () => {
        root.unmount()
      })
      host.remove()
    }
  }

  function readyVault() {
    register(VaultService)
    register(QuickOpenService)
    register(SearchPanelService)
    const vault = resolve(VaultService)
    vault.phase = 'ready'
    vault.notes = [note('a', 'Alpha'), note('b', 'Beta'), note('c', 'Gamma')]
    vault.activeId = 'a'
    return vault
  }

  it('routes every manifest shortcut through dispatchKeydown to a registered handler (no dead bindings)', async () => {
    const vault = readyVault()
    const service = resolve(CommandService)
    const tabs = resolve(TabsService)
    // Give the active tab a past and a future so canGoBack/canGoForward are on:
    // a → b → c, then one step back.
    tabs.openNote('a')
    tabs.followLink('b')
    tabs.followLink('c')
    tabs.goBack()
    expect(vault.activeId).toBe('b')
    expect(tabs.canGoBack).toBe(true)
    expect(tabs.canGoForward).toBe(true)

    const unmountPalette = await mountCommandPalette()
    const execute = vi.spyOn(service, 'execute').mockReturnValue(true)
    try {
      const find = commands.find((command) => command.id === 'edit.find')
      expect(find?.shortcut).toBeTruthy()
      // FindBar is not mounted. 不含组件 handler — a missing builtin still fails below.
      expect(service.isRunnable(find!), 'edit.find is not covered by this matrix').toBe(false)

      const withShortcuts = commands.filter((command) => command.shortcut && command.id !== 'edit.find')
      expect(withShortcuts.length).toBeGreaterThan(0)
      expect(withShortcuts.some((command) => command.id === 'app.commandPalette')).toBe(true)
      for (const command of withShortcuts) {
        // No dead bindings: a builtin or mounted handler must be live.
        expect(service.isRunnable(command), `${command.id} has no runnable handler`).toBe(true)
        const init = shortcutToKeyEventInit(command.shortcut!)!
        const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
        expect(service.dispatchKeydown(event), `${command.id} ("${command.shortcut}") did not dispatch`).toBe(true)
        expect(event.defaultPrevented).toBe(true)
        expect(execute, `${command.id} routed to the wrong handler`).toHaveBeenLastCalledWith(command.id)
      }
    } finally {
      execute.mockRestore()
      await unmountPalette()
    }
  })

  it('fires Mod commands from inside text inputs and leaves non-command keys alone', () => {
    readyVault()
    const service = resolve(CommandService)
    const unstub = service.registerHandler('app.commandPalette', { run: () => {} })
    // The overlays install this same listener; it is the real dispatch path.
    const onKeyDown = (event: KeyboardEvent) => {
      service.dispatchKeydown(event)
    }
    window.addEventListener('keydown', onKeyDown, true)
    const input = document.createElement('input')
    document.body.appendChild(input)
    try {
      input.focus()
      const execute = vi.spyOn(service, 'execute').mockReturnValue(true)
      // A Mod chord targeted at a focused input still routes (global app command).
      const chord = new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true, cancelable: true })
      input.dispatchEvent(chord)
      expect(chord.defaultPrevented).toBe(true)
      expect(execute).toHaveBeenLastCalledWith('app.commandPalette')
      // Bare typing inside the input is never claimed by the dispatcher.
      const typed = new KeyboardEvent('keydown', { key: 'k', bubbles: true, cancelable: true })
      input.dispatchEvent(typed)
      expect(typed.defaultPrevented).toBe(false)
      execute.mockRestore()
    } finally {
      window.removeEventListener('keydown', onKeyDown, true)
      input.remove()
      unstub()
    }
  })

  it('gates vault commands off in the chooser phase while Mod+K stays available', () => {
    register(VaultService)
    const vault = resolve(VaultService)
    vault.phase = 'chooser'
    vault.activeId = ''
    const service = resolve(CommandService)
    const unstub = service.registerHandler('app.commandPalette', { run: () => {} })
    try {
      const blocked = new KeyboardEvent('keydown', { key: 'p', metaKey: true, cancelable: true })
      expect(service.dispatchKeydown(blocked)).toBe(false)
      expect(blocked.defaultPrevented).toBe(false)

      const palette = new KeyboardEvent('keydown', { key: 'k', metaKey: true, cancelable: true })
      expect(service.dispatchKeydown(palette)).toBe(true)
      expect(palette.defaultPrevented).toBe(true)
    } finally {
      unstub()
    }
  })

  it('registers a handler for every manifest id (presence, not runnability)', async () => {
    readyVault()
    const service = resolve(CommandService)
    const unmountPalette = await mountCommandPalette()
    try {
      const handlers = (service as unknown as { handlers: Map<string, unknown> }).handlers
      // FindBar is not mounted. 不含组件 handler for edit.find.
      expect(handlers.has('edit.find'), 'edit.find must not be stubbed into this matrix').toBe(false)
      for (const command of commands) {
        if (command.id === 'edit.find') continue
        expect(handlers.has(command.id), `${command.id} has no registered handler`).toBe(true)
      }
    } finally {
      await unmountPalette()
    }
  })
})
