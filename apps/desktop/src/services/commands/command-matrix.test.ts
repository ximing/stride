import { has, register, resolve } from '@rabjs/react'
import { createNote, type StrideNote } from '@stride/core/note'
import { afterEach, describe, expect, it, vi } from 'vitest'
import manifest from '../../appCommandManifest.json'
import { CommandService } from './command.service'
import {
  COMMAND_CONDITIONS,
  commandForKeyEvent,
  parseAppCommandManifest,
  parseShortcut,
  shortcutToKeyEventInit,
  type AppCommand,
} from './commands'
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
// They describe editing commands and must never collide with a manifest chord:
// the dispatcher listens on window capture and would silently shadow the editor.
const EDITOR_KEYMAP_CHORDS = [
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
    expect(new Set(COMMAND_CONDITIONS)).toEqual(
      new Set(['vaultReady', 'hasActiveNote', 'gitReady', 'canGoBack', 'canGoForward', 'hasListSelection']),
    )
    // Behavioral spot-check: with no vault open, every conditioned command is disabled.
    register(VaultService)
    const vault = resolve(VaultService)
    vault.phase = 'chooser'
    vault.activeId = ''
    const service = resolve(CommandService)
    for (const command of commands) {
      if (!command.enabledWhen) continue
      expect(service.isEnabled(command), `${command.id} gated on ${command.enabledWhen}`).toBe(false)
    }
    // Ungated commands (palette) stay enabled in the chooser.
    for (const command of commands) {
      if (command.enabledWhen) continue
      expect(service.isEnabled(command), command.id).toBe(true)
    }
  })
})

describe('shortcut dispatch matrix', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

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

  it('routes every manifest shortcut through dispatchKeydown to a registered handler (no dead bindings)', () => {
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

    // The two component-owned handlers (palette, find bar) are stubbed here;
    // their components register the real ones when mounted.
    const unstub = [
      service.registerHandler('app.commandPalette', { run: () => {} }),
      service.registerHandler('edit.find', { run: () => {} }),
    ]
    const execute = vi.spyOn(service, 'execute').mockReturnValue(true)
    try {
      const withShortcuts = commands.filter((command) => command.shortcut)
      expect(withShortcuts.length).toBeGreaterThan(0)
      for (const command of withShortcuts) {
        // No dead bindings: a handler must be live for every shortcut command.
        expect(service.isRunnable(command), `${command.id} has no runnable handler`).toBe(true)
        const init = shortcutToKeyEventInit(command.shortcut!)!
        const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
        expect(service.dispatchKeydown(event), `${command.id} ("${command.shortcut}") did not dispatch`).toBe(true)
        expect(event.defaultPrevented).toBe(true)
        expect(execute, `${command.id} routed to the wrong handler`).toHaveBeenLastCalledWith(command.id)
      }
    } finally {
      execute.mockRestore()
      for (const unregister of unstub) unregister()
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

  it('registers a handler for every manifest id (presence, not runnability)', () => {
    readyVault()
    const service = resolve(CommandService)
    const unstub = [
      service.registerHandler('app.commandPalette', { run: () => {} }),
      service.registerHandler('edit.find', { run: () => {} }),
    ]
    try {
      const handlers = (service as unknown as { handlers: Map<string, unknown> }).handlers
      for (const command of commands) {
        expect(handlers.has(command.id), `${command.id} has no registered handler`).toBe(true)
      }
    } finally {
      for (const unregister of unstub) unregister()
    }
  })
})
