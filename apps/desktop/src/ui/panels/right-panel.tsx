import { observer, useService } from '@rabjs/react'
import { useTranslation } from 'react-i18next'
import {
  GitBranch,
  List,
  MessageCircle,
  PanelRightClose,
  SlidersHorizontal,
  type LucideIcon,
} from 'lucide-react'
import { LayoutService } from '../../services/layout/layout.service'
import type { RightPanelTab } from '../../services/layout/layout'
import { IconButton } from '../primitives/button'
import { ChatPanel } from '../chat/chat-panel'
import { GitPanel } from '../git/git-panel-host'
import { PropertiesPanel } from './properties-panel'
import { TocPanel } from './toc-panel'

const PANEL_TABS: { id: RightPanelTab; labelKey: string; icon: LucideIcon }[] = [
  { id: 'properties', labelKey: 'panels.properties', icon: SlidersHorizontal },
  { id: 'toc', labelKey: 'panels.outline', icon: List },
  { id: 'git', labelKey: 'panels.git', icon: GitBranch },
  { id: 'chat', labelKey: 'panels.agent', icon: MessageCircle },
]

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
      title={label}
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

/** Slim vertical icon strip shown while the right panel is collapsed. */
export const PanelRail = observer(function PanelRail() {
  return (
    <aside className="panel-rail" data-testid="panel-rail">
      <PanelTabs collapsed />
    </aside>
  )
})

export const RightPanel = observer(function RightPanel() {
  const { t } = useTranslation()
  const layout = useService(LayoutService)
  return (
    <div className="panel-wrap" data-testid="right-panel">
      <div className="panel-head">
        <PanelTabs collapsed={false} />
        <IconButton
          icon={PanelRightClose}
          label={t('shell.hidePanel')}
          className="panel-tab panel-collapse"
          data-testid="panel-collapse"
          onClick={() => layout.setRightPanelCollapsed(true)}
        />
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
