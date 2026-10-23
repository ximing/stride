import { observer, useService } from '@rabjs/react'
import { PanelRight, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { commandTitle } from '../../i18n'
import { CommandService, showsShortcutHint } from '../../services/commands/command.service'
import { commandShortcut } from '../../services/commands/commands'
import { LayoutService } from '../../services/layout/layout.service'
import { TabsService } from '../../services/notes/tabs.service'
import { VaultService } from '../../services/vault/vault.service'
import { IconButton } from '../primitives/button'

/**
 * Editor tab strip: one tab per open note (title derived live from vault.notes,
 * so renames follow automatically). Hidden while no vault is open. With no tabs
 * the band stays so the column headers share one line.
 * Tabs scroll horizontally on the left; a fixed action group (inspector toggle)
 * anchors the right edge. Close via the hover-revealed close button or middle
 * click. While the active note has unsaved changes the active tab shows a dirty
 * dot instead of the close button (hover swaps it back, pure CSS).
 */
export const TabStrip = observer(function TabStrip() {
  const { t } = useTranslation()
  const tabs = useService(TabsService)
  const vault = useService(VaultService)
  const commands = useService(CommandService)
  const layout = useService(LayoutService)
  if (vault.phase !== 'ready') return null
  // Chord text comes from the manifest. Desktop hint UI omits chords the webview does not dispatch.
  const closeKeys = showsShortcutHint('tab.close') ? commandShortcut(commands.commands, 'tab.close') : null
  const closeName = commandTitle('tab.close', 'Close tab')
  const closeLabel = closeKeys ? `${closeName} (${closeKeys})` : closeName
  const saving = vault.saveStatus === 'pending' || vault.saveStatus === 'saving'
  return (
    <div className="tab-strip" data-testid="tab-strip" role="tablist" aria-label={t('shell.openNotes')} data-tauri-drag-region="deep">
      <div className="tabs-scroll">
        {tabs.tabs.map((tab) => {
          const note = vault.notes.find((item) => item.id === tab.noteId)
          const title = note?.title || t('notes.untitled')
          const active = tab.id === tabs.activeTabId
          const dirty = active && saving
          return (
            <div
              key={tab.id}
              className={dirty ? 'tab dirty' : 'tab'}
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
              {dirty ? <span className="dirty-dot" aria-hidden="true" /> : null}
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
      <div className="stage-actions">
        <IconButton
          icon={PanelRight}
          label={t('shell.togglePanel')}
          className="stage-panel-toggle"
          data-testid="stage-panel-toggle"
          active={!layout.rightPanelCollapsed}
          aria-pressed={!layout.rightPanelCollapsed}
          size="sm"
          onClick={() => layout.toggleRightPanel()}
        />
      </div>
    </div>
  )
})
