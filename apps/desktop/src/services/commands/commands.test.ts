import { describe, expect, it } from 'vitest'
import manifest from '../../appCommandManifest.json'
import { isFindShortcut } from '../../editor/find/find'
import {
  COMMAND_CONDITIONS,
  commandForKeyEvent,
  filterCommands,
  formatShortcut,
  matchShortcut,
  parseAppCommandManifest,
  parseShortcut,
  shortcutToKeyEventInit,
} from './commands'
import { isSearchPanelShortcut } from '../search/search-panel.service'

function keyEvent(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent('keydown', init)
}

describe('manifest schema', () => {
  it('parses the shipped manifest and every enabledWhen references a registered condition', () => {
    const commands = parseAppCommandManifest(manifest)
    expect(commands.length).toBeGreaterThan(0)
    for (const command of commands) {
      expect(command.id).toBeTruthy()
      expect(command.title).toBeTruthy()
      if (command.enabledWhen) expect(COMMAND_CONDITIONS).toContain(command.enabledWhen)
    }
  })

  it('rejects duplicate ids, bad shortcuts, and unknown conditions', () => {
    expect(() => parseAppCommandManifest(null)).toThrow(/object/)
    expect(() => parseAppCommandManifest({})).toThrow(/commands/)
    expect(() =>
      parseAppCommandManifest({ commands: [{ id: 'a', title: 'A', section: 'File' }, { id: 'a', title: 'B', section: 'File' }] }),
    ).toThrow(/duplicate/)
    expect(() =>
      parseAppCommandManifest({ commands: [{ id: 'x', title: 'X', section: 'File', shortcut: 'Mod+' }] }),
    ).toThrow(/shortcut/)
    expect(() =>
      parseAppCommandManifest({ commands: [{ id: 'x', title: 'X', section: 'File', shortcut: 'Banana+K' }] }),
    ).toThrow(/shortcut/)
    expect(() =>
      parseAppCommandManifest({ commands: [{ id: 'x', title: 'X', section: 'File', enabledWhen: 'nope' }] }),
    ).toThrow(/enabledWhen/)
    expect(() =>
      parseAppCommandManifest({ commands: [{ id: 'x', title: '', section: 'File' }] }),
    ).toThrow(/title/)
    expect(() =>
      parseAppCommandManifest({ commands: [{ id: 'x', title: 'X', section: 'File', keywords: 'oops' }] }),
    ).toThrow(/keywords/)
  })
})

describe('parseShortcut', () => {
  it('parses modifiers and keys, folding Ctrl into Mod', () => {
    expect(parseShortcut('Mod+K')).toEqual({ mod: true, alt: false, shift: false, key: 'k' })
    expect(parseShortcut('Mod+Shift+F')).toEqual({ mod: true, alt: false, shift: true, key: 'f' })
    expect(parseShortcut('Ctrl+P')).toEqual({ mod: true, alt: false, shift: false, key: 'p' })
    expect(parseShortcut('Mod+[')).toEqual({ mod: true, alt: false, shift: false, key: '[' })
    expect(parseShortcut('Mod')).toBeNull()
    expect(parseShortcut('Mod++K')).toBeNull()
    expect(parseShortcut('Mod+Mod+K')).toBeNull()
    expect(parseShortcut('Mod+Ctrl+K')).toBeNull()
    expect(parseShortcut('Mod+NotAKey')).toBeNull()
    expect(parseShortcut('')).toBeNull()
  })
})

describe('matchShortcut', () => {
  it('matches meta or ctrl for Mod, requires exact shift and alt state, and ignores key case', () => {
    expect(matchShortcut('Mod+P', keyEvent({ key: 'p', metaKey: true }))).toBe(true)
    expect(matchShortcut('Mod+P', keyEvent({ key: 'P', ctrlKey: true }))).toBe(true)
    expect(matchShortcut('Mod+P', keyEvent({ key: 'p', metaKey: true, shiftKey: true }))).toBe(false)
    expect(matchShortcut('Mod+P', keyEvent({ key: 'p', metaKey: true, altKey: true }))).toBe(false)
    expect(matchShortcut('Mod+P', keyEvent({ key: 'p' }))).toBe(false)
    expect(matchShortcut('Mod+Shift+F', keyEvent({ key: 'F', metaKey: true, shiftKey: true }))).toBe(true)
    expect(matchShortcut('Mod+Shift+F', keyEvent({ key: 'f', metaKey: true, ctrlKey: true, shiftKey: true }))).toBe(true)
    expect(matchShortcut('Mod+Shift+F', keyEvent({ key: 'f', metaKey: true }))).toBe(false)
    expect(matchShortcut('Mod+Shift+F', keyEvent({ key: 'f', metaKey: true, shiftKey: true, altKey: true }))).toBe(false)
  })

  it('matches the legacy quick-open / search / find predicates exactly', () => {
    const matrix: KeyboardEventInit[] = [
      { key: 'p' },
      { key: 'p', metaKey: true },
      { key: 'P', ctrlKey: true },
      { key: 'p', metaKey: true, shiftKey: true },
      { key: 'p', metaKey: true, altKey: true },
      { key: 'f', metaKey: true },
      { key: 'F', ctrlKey: true },
      { key: 'f', metaKey: true, shiftKey: true },
      { key: 'F', ctrlKey: true, shiftKey: true },
      { key: 'f', metaKey: true, ctrlKey: true, shiftKey: true },
      { key: 'f', metaKey: true, shiftKey: true, altKey: true },
      { key: 'f', metaKey: true, altKey: true },
      { key: 'f', shiftKey: true },
      { key: 'f' },
    ]
    for (const init of matrix) {
      const event = keyEvent(init)
      expect(matchShortcut('Mod+P', event)).toBe(
        !event.shiftKey && !event.altKey && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'p',
      )
      expect(matchShortcut('Mod+Shift+F', event)).toBe(isSearchPanelShortcut(event))
      expect(matchShortcut('Mod+F', event)).toBe(isFindShortcut(event))
    }
  })

  it('shortcutToKeyEventInit round-trips every manifest shortcut through the matcher', () => {
    const commands = parseAppCommandManifest(manifest)
    const withShortcuts = commands.filter((command) => command.shortcut)
    expect(withShortcuts.length).toBeGreaterThan(0)
    for (const command of withShortcuts) {
      const init = shortcutToKeyEventInit(command.shortcut!)
      expect(init).not.toBeNull()
      const event = keyEvent(init!)
      expect(matchShortcut(command.shortcut!, event)).toBe(true)
      expect(commandForKeyEvent(commands, event)?.id).toBe(command.id)
    }
  })
})

describe('commandForKeyEvent', () => {
  it('returns null for unbound keys and respects manifest order', () => {
    const commands = parseAppCommandManifest(manifest)
    expect(commandForKeyEvent(commands, keyEvent({ key: 'x' }))).toBeNull()
    expect(commandForKeyEvent(commands, keyEvent({ key: 'k', metaKey: true }))?.id).toBe('app.commandPalette')
    expect(commandForKeyEvent(commands, keyEvent({ key: 'n', ctrlKey: true }))?.id).toBe('file.newNote')
  })
})

describe('filterCommands', () => {
  const commands = parseAppCommandManifest(manifest)

  it('lists everything for an empty query and matches title, id, section, and keywords', () => {
    expect(filterCommands(commands, '')).toHaveLength(commands.length)
    expect(filterCommands(commands, '  ')).toHaveLength(commands.length)
    expect(filterCommands(commands, 'quick').map((command) => command.id)).toEqual(['nav.quickOpen'])
    expect(filterCommands(commands, 'nav.quick').map((command) => command.id)).toEqual(['nav.quickOpen'])
    expect(filterCommands(commands, 'view').length).toBeGreaterThan(1)
    expect(filterCommands(commands, '新建').map((command) => command.id)).toContain('file.newNote')
    expect(filterCommands(commands, 'zzzz-no-match')).toEqual([])
  })

  it('is case-insensitive', () => {
    expect(filterCommands(commands, 'QUICK')).toEqual(filterCommands(commands, 'quick'))
  })
})

describe('formatShortcut', () => {
  it('renders mac symbols and ctrl-style text', () => {
    expect(formatShortcut('Mod+K', 'mac')).toBe('⌘K')
    expect(formatShortcut('Mod+Shift+F', 'mac')).toBe('⌘⇧F')
    expect(formatShortcut('Mod+K', 'other')).toBe('Ctrl+K')
    expect(formatShortcut('Mod+Shift+F', 'other')).toBe('Ctrl+Shift+F')
  })
})
