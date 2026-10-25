import { observer, useService } from '@rabjs/react'
import { useTranslation } from 'react-i18next'
import {
  Archive,
  ArchiveRestore,
  GitBranch,
  List,
  MessageCircle,
  SlidersHorizontal,
  Trash2,
  type LucideIcon,
} from 'lucide-react'
import { useState } from 'react'
import { isArchived } from '@stride/core/note'
import { LayoutService } from '../../services/layout/layout.service'
import { RIGHT_PANEL_TABS, type RightPanelTab } from '../../services/layout/layout'
import { VaultService } from '../../services/vault/vault.service'
import { Button, IconButton } from '../primitives/button'
import { Modal, ModalClose, ModalContent } from '../primitives/modal'
import { ChatPanel } from '../chat/chat-panel'
import { GitPanel } from '../git/git-panel-host'
import { PropertiesPanel } from './properties-panel'
import { TocPanel } from './toc-panel'

export const TAB_CHROME: Record<RightPanelTab, { labelKey: string; icon: LucideIcon }> = {
  properties: { labelKey: 'panels.properties', icon: SlidersHorizontal },
  toc: { labelKey: 'panels.outline', icon: List },
  git: { labelKey: 'panels.git', icon: GitBranch },
  chat: { labelKey: 'panels.agent', icon: MessageCircle },
}

const PANEL_TABS = RIGHT_PANEL_TABS.map((id) => ({ id, ...TAB_CHROME[id] }))

const TabButton = observer(function TabButton({ tab, collapsed }: { tab: (typeof PANEL_TABS)[number]; collapsed: boolean }) {
  const { t } = useTranslation()
  const layout = useService(LayoutService)
  const label = t(tab.labelKey)
  const active = !collapsed && layout.rightPanelTab === tab.id
  return (
    <IconButton
      key={tab.id}
      icon={tab.icon}
      label={label}
      active={active}
      className="panel-tab"
      data-testid={`panel-tab-${tab.id}`}
      data-panel={tab.id}
      role="tab"
      aria-selected={active}
      onClick={() => {
        if (!collapsed && layout.rightPanelTab === tab.id) layout.setRightPanelCollapsed(true)
        else layout.setRightPanelTab(tab.id)
      }}
    />
  )
})

const PanelTabs = observer(function PanelTabs({ collapsed }: { collapsed: boolean }) {
  const { t } = useTranslation()
  return (
    <div className="panel-tabs" role="tablist" aria-label={t('shell.inspectorTabs')}>
      {PANEL_TABS.map((tab) => (
        <TabButton key={tab.id} tab={tab} collapsed={collapsed} />
      ))}
    </div>
  )
})

/**
 * Always-on icon rail pinned to the window's right edge. Rendered in both
 * collapsed and expanded inspector states; the collapsed state is "rail only".
 */
export const InspectorRail = observer(function InspectorRail() {
  const layout = useService(LayoutService)
  return (
    <aside className="panel-rail" data-testid="panel-rail">
      <PanelTabs collapsed={layout.rightPanelCollapsed} />
    </aside>
  )
})

/** Note-level actions for the properties tab: two operations, so they sit
 * inline beside the panel title instead of hiding behind a ⋯ menu. */
const NoteActions = observer(function NoteActions() {
  const { t } = useTranslation()
  const vault = useService(VaultService)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const note = vault.active
  if (!note) return null
  const archived = isArchived(note)
  return (
    <span className="panel-actions">
      <IconButton
        data-testid="archive-note"
        icon={archived ? ArchiveRestore : Archive}
        iconSize={15}
        label={archived ? t('panels.unarchive') : t('notes.archive')}
        size="sm"
        onClick={() => vault.updateBooleanProperty('archived', !archived)}
      />
      <IconButton
        data-testid="delete-note"
        icon={Trash2}
        iconSize={15}
        label={t('common.delete')}
        size="sm"
        onClick={() => setDeleteOpen(true)}
      />
      <Modal open={deleteOpen} onOpenChange={setDeleteOpen}>
        <ModalContent title={t('panels.deleteNote')} description={t('panels.deleteNoteBody')}>
          <div className="sd-modal-actions">
            <ModalClose asChild>
              <Button tone="secondary" data-testid="cancel-delete">{t('common.cancel')}</Button>
            </ModalClose>
            <Button
              tone="danger"
              data-testid="confirm-delete"
              onClick={() => {
                void vault.deleteActiveNote()
                setDeleteOpen(false)
              }}
            >
              {t('common.delete')}
            </Button>
          </div>
        </ModalContent>
      </Modal>
    </span>
  )
})

export const RightPanel = observer(function RightPanel() {
  const { t } = useTranslation()
  const layout = useService(LayoutService)
  return (
    <div className="panel-wrap" data-testid="right-panel">
      <div className="panel-head" data-tauri-drag-region="deep">
        <span className="panel-title">{t(TAB_CHROME[layout.rightPanelTab].labelKey)}</span>
        {layout.rightPanelTab === 'properties' && <NoteActions />}
      </div>
      <div className="panel-body">
        {layout.rightPanelTab === 'properties' && <PropertiesPanel />}
        {layout.rightPanelTab === 'toc' && <TocPanel />}
        {layout.rightPanelTab === 'git' && <GitPanel />}
        {layout.rightPanelTab === 'chat' && <ChatPanel />}
      </div>
    </div>
  )
})
