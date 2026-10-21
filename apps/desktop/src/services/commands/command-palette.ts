// Pure command-palette item logic: which commands/notes/AI entries show for a
// query. Reuses the quick-open title ranking for the note-jump section.
import type { StrideNote } from '@stride/core/note'
import { filterCommands, type AppCommand } from './commands'
import { rankQuickOpenNotes } from '../search/quick-open.service'

export const NEW_INSTANCE_COMMAND_ID = 'file.newInstance'
export const PALETTE_NOTE_LIMIT = 8

export type PaletteItem =
  | { kind: 'command'; key: string; command: AppCommand; enabled: boolean }
  | { kind: 'instance'; key: string; typeTitle: string; title: string; enabled: boolean }
  | { kind: 'note'; key: string; noteId: string; title: string }
  | { kind: 'ai'; key: string; prompt: string }

export function paletteItemTitle(item: PaletteItem): string {
  if (item.kind === 'ai') return item.prompt ? `Ask AI about “${item.prompt}”` : 'Ask AI…'
  if (item.kind === 'command') return item.command.title
  return item.title
}

/** Palette section labels in fixed render order. */
export function paletteItemSection(item: PaletteItem): string {
  if (item.kind === 'note') return '笔记'
  if (item.kind === 'ai') return 'AI'
  return '命令'
}

/**
 * Flat item list: manifest commands (file.newInstance expands into one item
 * per visible note type), then note-jump matches, then the AI entry.
 */
export function buildPaletteItems(options: {
  commands: readonly AppCommand[]
  query: string
  isRunnable: (command: AppCommand) => boolean
  notes: readonly StrideNote[]
  typeTitles: readonly string[]
  noteLimit?: number
}): PaletteItem[] {
  const needle = options.query.trim().toLowerCase()
  const items: PaletteItem[] = []
  for (const command of filterCommands(options.commands, options.query)) {
    if (command.id === NEW_INSTANCE_COMMAND_ID) continue
    items.push({ kind: 'command', key: `command:${command.id}`, command, enabled: options.isRunnable(command) })
  }
  const template = options.commands.find((command) => command.id === NEW_INSTANCE_COMMAND_ID)
  if (template) {
    const types = options.typeTitles.filter(
      (title) => !needle || title.toLowerCase().includes(needle) || `new ${title.toLowerCase()}`.includes(needle),
    )
    if (types.length > 0) {
      for (const typeTitle of types) {
        items.push({
          kind: 'instance',
          key: `instance:${typeTitle}`,
          typeTitle,
          title: `New ${typeTitle}`,
          enabled: options.isRunnable(template),
        })
      }
    } else if (filterCommands([template], options.query).length > 0) {
      // No types to expand into: show the template entry, disabled.
      items.push({ kind: 'command', key: `command:${template.id}`, command: template, enabled: false })
    }
  }
  const limit = options.noteLimit ?? PALETTE_NOTE_LIMIT
  for (const note of rankQuickOpenNotes(options.notes, options.query).slice(0, limit)) {
    items.push({ kind: 'note', key: `note:${note.id}`, noteId: note.id, title: note.title })
  }
  items.push({ kind: 'ai', key: 'ai:ask', prompt: options.query.trim() })
  return items
}
