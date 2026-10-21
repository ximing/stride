import { observer, useService } from '@rabjs/react'
import { X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { commandTitle } from '../../i18n'
import { CommandService } from '../../services/commands/command.service'
import { commandShortcut } from '../../services/commands/commands'
import { TabsService } from '../../services/notes/tabs.service'
import { VaultService } from '../../services/vault/vault.service'
import { IconButton } from '../primitives/button'

/**
 * Editor tab strip: one tab per open note (title derived live from vault.notes,
 * so renames follow automatically). Hidden while no vault is open or no tabs
 * exist. Close via the hover-revealed close button or middle click.
 */
export const TabStrip = observer(function TabStrip() {
  const { t } = useTranslation()
  const tabs = useService(TabsService)
  const vault = useService(VaultService)
  const commands = useService(CommandService)
  if (vault.phase !== 'ready' || tabs.tabs.length === 0) return null
  // Tooltip shortcut text comes from the manifest, never a hard-coded chord.
  const closeKeys = commandShortcut(commands.commands, 'tab.close')
  const closeName = commandTitle('tab.close', 'Close tab')
  const closeLabel = closeKeys ? `${closeName} (${closeKeys})` : closeName
  return (
    <div className="tab-strip" data-testid="tab-strip" role="tablist" aria-label={t('shell.openNotes')}>
      {tabs.tabs.map((tab) => {
        const note = vault.notes.find((item) => item.id === tab.noteId)
        const title = note?.title || t('notes.untitled')
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
            <IconButton
              icon={X}
              label={closeLabel}
              className="tab-close"
              data-testid="tab-close"
              title={closeLabel}
              onClick={() => tabs.closeTab(tab.id)}
            />
          </div>
        )
      })}
    </div>
  )
})
