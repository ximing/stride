import { has, register, Service } from '@rabjs/react'
import { buildPaletteItems, type PaletteItem } from './command-palette'
import { CommandService } from './command.service'
import { LayoutService } from './layout.service'
import { ChatService } from './panels.service'
import { TabsService } from './tabs.service'
import { VaultService } from './vault.service'

export class CommandPaletteService extends Service {
  open = false
  query = ''
  selected = 0

  private get commands() {
    return this.resolve(CommandService)
  }

  private get vault() {
    return this.resolve(VaultService)
  }

  get items(): PaletteItem[] {
    return buildPaletteItems({
      commands: this.commands.commands,
      query: this.query,
      isRunnable: (command) => this.commands.isRunnable(command),
      notes: this.vault.notes,
      typeTitles: this.vault.sidebarTypes.map((type) => type.title),
    })
  }

  show() {
    if (this.open) return
    this.query = ''
    this.selected = 0
    this.open = true
  }

  close() {
    this.open = false
    this.query = ''
    this.selected = 0
  }

  toggle() {
    if (this.open) this.close()
    else this.show()
  }

  setQuery(value: string) {
    if (value === this.query) return
    this.query = value
    this.selected = 0
  }

  move(delta: number) {
    const total = this.items.length
    if (total === 0) return
    const current = Math.min(Math.max(this.selected, 0), total - 1)
    const next = current + delta
    if (next < 0 || next >= total) return
    this.selected = next
  }

  confirm() {
    const items = this.items
    if (items.length === 0) return
    const item = items[Math.min(Math.max(this.selected, 0), items.length - 1)]
    if (!item) return
    this.activate(item)
  }

  activate(item: PaletteItem) {
    if (item.kind === 'command') {
      if (!item.enabled || !this.commands.isRunnable(item.command)) return
      this.close()
      this.commands.execute(item.command.id)
      return
    }
    if (item.kind === 'instance') {
      if (!item.enabled) return
      this.close()
      void this.vault.createInstance(item.typeTitle)
      return
    }
    if (item.kind === 'note') {
      this.close()
      this.resolve(TabsService).openNote(item.noteId)
      return
    }
    // AI placeholder: hand the query to the chat panel as a draft.
    this.close()
    this.resolve(LayoutService).setRightPanelTab('chat')
    if (item.prompt && has(ChatService)) this.resolve(ChatService).setDraft(item.prompt)
  }
}

// Tests mount the palette without main.tsx, so the global service must exist on import.
if (!has(CommandPaletteService)) register(CommandPaletteService)
