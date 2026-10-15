import { X } from '@phosphor-icons/react'
import { observer, useService } from '@rabjs/react'
import { CommandService } from '../services/command.service'
import { commandShortcut } from '../services/commands'
import { TabsService } from '../services/tabs.service'
import { VaultService } from '../services/vault.service'
import { Mark } from './icon'

/**
 * Editor tab strip: one tab per open note (title derived live from vault.notes,
 * so renames follow automatically). Hidden while no vault is open or no tabs
 * exist. Close via the hover-revealed × button or middle click.
 */
export const TabStrip = observer(function TabStrip() {
  const tabs = useService(TabsService)
  const vault = useService(VaultService)
  const commands = useService(CommandService)
  if (vault.phase !== 'ready' || tabs.tabs.length === 0) return null
  // Tooltip shortcut text comes from the manifest, never a hard-coded chord.
  const closeKeys = commandShortcut(commands.commands, 'tab.close')
  const closeLabel = closeKeys ? `Close tab (${closeKeys})` : 'Close tab'
  return (
    <div className="tab-strip" data-testid="tab-strip" role="tablist" aria-label="Open notes">
      {tabs.tabs.map((tab) => {
        const note = vault.notes.find((item) => item.id === tab.noteId)
        const title = note?.title || 'Untitled'
        const active = tab.id === tabs.activeTabId
        return (
          <div
            key={tab.id}
            className="tab"
            data-testid="tab-item"
            data-note-id={tab.noteId}
            role="tab"
            aria-selected={active}
          >
            <button
              type="button"
              className="tab-main"
              title={title}
              onClick={() => tabs.activateTab(tab.id)}
              onAuxClick={(event) => {
                if (event.button !== 1) return
                event.preventDefault()
                tabs.closeTab(tab.id)
              }}
            >
              <span className="tab-title">{title}</span>
            </button>
            <button
              type="button"
              className="tab-close"
              data-testid="tab-close"
              aria-label={closeLabel}
              title={closeLabel}
              onClick={() => tabs.closeTab(tab.id)}
            >
              <Mark icon={X} size={12} />
            </button>
          </div>
        )
      })}
    </div>
  )
})
