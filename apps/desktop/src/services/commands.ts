// Pure command-manifest logic: schema, validation, shortcut parsing/matching,
// and palette filtering. No rabjs or service dependencies so it stays
// unit-testable. `appCommandManifest.json` is the single source of truth for
// commands, shortcuts, and the command palette.
//
// Adding a shortcut takes three steps (pinned by command-matrix.test.ts):
//   1. Add the manifest entry (id, title, section, shortcut, enabledWhen).
//   2. Register its handler — CommandService.registerBuiltinHandlers, or the
//      owning component via registerHandler when a local closure is needed.
//   3. Extend the matrix test if the command needs a new enabledWhen condition
//      (COMMAND_CONDITIONS + CommandService.conditions).
//
// Input-focus semantics (also pinned by the matrix test):
//   - Every manifest shortcut carries Mod, so app commands fire globally —
//     inside text inputs and the editor included. Typing is never hijacked
//     because bare-key (modifier-less) shortcuts are policy-forbidden here.
//   - The TipTap editor keymap owns editing chords (Mod+B, Mod+Alt+2, …).
//     Those chords must never overlap a manifest chord; the dispatcher listens
//     on window capture and wins any overlap, which would silently kill the
//     editor binding.
//   - Overlay-local keys (arrows, Enter, Escape) are handled by each overlay's
//     own listener after dispatchKeydown passes, and only while it is open.

export interface AppCommand {
  id: string
  title: string
  /** e.g. "Mod+K". Mod means Cmd on macOS / Ctrl elsewhere. */
  shortcut?: string
  section: string
  enabledWhen?: string
  keywords?: string[]
}

export interface AppCommandManifest {
  version: number
  commands: AppCommand[]
}

/** Condition ids a manifest `enabledWhen` may reference. CommandService implements all of them. */
export const COMMAND_CONDITIONS = ['vaultReady', 'hasActiveNote', 'gitReady', 'canGoBack', 'canGoForward', 'hasListSelection'] as const

const MODIFIER_TOKENS = new Set(['Mod', 'Ctrl', 'Alt', 'Shift'])

const NAMED_KEYS = new Set([
  'enter',
  'escape',
  'tab',
  'space',
  'backspace',
  'delete',
  'home',
  'end',
  'pageup',
  'pagedown',
  'arrowup',
  'arrowdown',
  'arrowleft',
  'arrowright',
  ...Array.from({ length: 12 }, (_, index) => `f${index + 1}`),
])

export interface ParsedShortcut {
  /** True when the chord needs Cmd (macOS) or Ctrl (elsewhere). "Ctrl" is accepted as an alias. */
  mod: boolean
  alt: boolean
  shift: boolean
  /** Lowercased key: a single printable character or a named key ("enter", "arrowdown", …). */
  key: string
}

function normalizeKey(token: string): string {
  const lower = token.toLowerCase()
  if (lower.length === 1) return lower
  if (NAMED_KEYS.has(lower)) return lower
  return ''
}

/** Parse "Mod+Shift+F" style chords. Returns null for malformed input. */
export function parseShortcut(shortcut: string): ParsedShortcut | null {
  if (typeof shortcut !== 'string' || shortcut.trim() === '') return null
  const tokens = shortcut.split('+').map((token) => token.trim())
  if (tokens.some((token) => token === '')) return null
  const key = normalizeKey(tokens[tokens.length - 1] ?? '')
  if (!key) return null
  const parsed: ParsedShortcut = { mod: false, alt: false, shift: false, key }
  const seen = new Set<string>()
  for (const token of tokens.slice(0, -1)) {
    if (!MODIFIER_TOKENS.has(token)) return null
    // Stride treats Cmd and Ctrl as one modifier everywhere, so "Ctrl" folds into Mod.
    const canonical = token === 'Ctrl' ? 'Mod' : token
    if (seen.has(canonical)) return null
    seen.add(canonical)
    if (canonical === 'Mod') parsed.mod = true
    else if (canonical === 'Alt') parsed.alt = true
    else parsed.shift = true
  }
  return parsed
}

/** A shortcut matches when modifier state is exact and the key matches case-insensitively. */
export function matchShortcut(shortcut: string, event: KeyboardEvent): boolean {
  const parsed = parseShortcut(shortcut)
  if (!parsed) return false
  const modPressed = event.metaKey || event.ctrlKey
  if (parsed.mod !== modPressed) return false
  if (parsed.alt !== event.altKey) return false
  if (parsed.shift !== event.shiftKey) return false
  return event.key.toLowerCase() === parsed.key
}

/** First manifest command whose shortcut matches the event, in manifest order. */
export function commandForKeyEvent(commands: readonly AppCommand[], event: KeyboardEvent): AppCommand | null {
  for (const command of commands) {
    if (command.shortcut && matchShortcut(command.shortcut, event)) return command
  }
  return null
}

/** Test/playback helper: synthesize a KeyboardEventInit that matchShortcut accepts. */
export function shortcutToKeyEventInit(shortcut: string): KeyboardEventInit | null {
  const parsed = parseShortcut(shortcut)
  if (!parsed) return null
  let key = parsed.key
  if (key.length === 1) key = parsed.shift ? key.toUpperCase() : key
  else key = key[0]!.toUpperCase() + key.slice(1)
  return {
    key,
    ctrlKey: parsed.mod,
    metaKey: false,
    shiftKey: parsed.shift,
    altKey: parsed.alt,
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function validateCommand(entry: unknown, index: number, ids: Set<string>, knownConditions: readonly string[]): AppCommand {
  const where = `commands[${index}]`
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error(`manifest ${where} must be an object`)
  }
  const raw = entry as Record<string, unknown>
  if (!isNonEmptyString(raw.id)) throw new Error(`manifest ${where}.id must be a non-empty string`)
  const id = raw.id
  if (ids.has(id)) throw new Error(`manifest has a duplicate command id "${id}"`)
  ids.add(id)
  if (!isNonEmptyString(raw.title)) throw new Error(`manifest ${where} ("${id}").title must be a non-empty string`)
  if (!isNonEmptyString(raw.section)) throw new Error(`manifest ${where} ("${id}").section must be a non-empty string`)
  const command: AppCommand = { id, title: raw.title, section: raw.section }
  if (raw.shortcut !== undefined) {
    if (typeof raw.shortcut !== 'string' || !parseShortcut(raw.shortcut)) {
      throw new Error(`manifest ${where} ("${id}").shortcut "${String(raw.shortcut)}" is not a valid chord`)
    }
    command.shortcut = raw.shortcut
  }
  if (raw.enabledWhen !== undefined) {
    if (typeof raw.enabledWhen !== 'string' || !knownConditions.includes(raw.enabledWhen)) {
      throw new Error(`manifest ${where} ("${id}").enabledWhen "${String(raw.enabledWhen)}" is not a registered condition`)
    }
    command.enabledWhen = raw.enabledWhen
  }
  if (raw.keywords !== undefined) {
    if (!Array.isArray(raw.keywords) || raw.keywords.some((keyword) => typeof keyword !== 'string')) {
      throw new Error(`manifest ${where} ("${id}").keywords must be an array of strings`)
    }
    command.keywords = [...raw.keywords] as string[]
  }
  return command
}

/** Validate raw manifest JSON into typed commands. Throws on any schema violation. */
export function parseAppCommandManifest(
  raw: unknown,
  knownConditions: readonly string[] = COMMAND_CONDITIONS,
): AppCommand[] {
  if (!raw || typeof raw !== 'object') throw new Error('manifest must be an object')
  const commands = (raw as { commands?: unknown }).commands
  if (!Array.isArray(commands)) throw new Error('manifest.commands must be an array')
  const ids = new Set<string>()
  return commands.map((entry, index) => validateCommand(entry, index, ids, knownConditions))
}

/** Case-insensitive substring match over title, id, section, and keywords. Empty query lists everything. */
export function filterCommands(commands: readonly AppCommand[], query: string): AppCommand[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return [...commands]
  return commands.filter((command) => {
    if (command.title.toLowerCase().includes(needle)) return true
    if (command.id.toLowerCase().includes(needle)) return true
    if (command.section.toLowerCase().includes(needle)) return true
    return (command.keywords ?? []).some((keyword) => keyword.toLowerCase().includes(needle))
  })
}

function detectPlatform(): 'mac' | 'other' {
  if (typeof navigator === 'undefined') return 'mac'
  const platform = navigator.platform || ''
  return /mac|iphone|ipad|ipod/i.test(platform) ? 'mac' : 'other'
}

/** Human-readable chord: "⌘⇧F" on macOS, "Ctrl+Shift+F" elsewhere. */
export function formatShortcut(shortcut: string, platform: 'mac' | 'other' = detectPlatform()): string {
  const parsed = parseShortcut(shortcut)
  if (!parsed) return shortcut
  const key = parsed.key.length === 1 ? parsed.key.toUpperCase() : parsed.key[0]!.toUpperCase() + parsed.key.slice(1)
  if (platform === 'mac') {
    return `${parsed.mod ? '⌘' : ''}${parsed.shift ? '⇧' : ''}${parsed.alt ? '⌥' : ''}${key}`
  }
  const parts: string[] = []
  if (parsed.mod) parts.push('Ctrl')
  if (parsed.alt) parts.push('Alt')
  if (parsed.shift) parts.push('Shift')
  parts.push(key)
  return parts.join('+')
}

/**
 * Formatted shortcut for a command id, or null when it has none. UI tooltips
 * and labels must go through this so shortcut text always reads the manifest.
 */
export function commandShortcut(commands: readonly AppCommand[], id: string): string | null {
  const shortcut = commands.find((command) => command.id === id)?.shortcut
  return shortcut ? formatShortcut(shortcut) : null
}
