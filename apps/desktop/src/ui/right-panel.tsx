import { observer, useService } from '@rabjs/react'
import {
  GitBranch,
  List,
  MessageCircle,
  PanelRightClose,
  SlidersHorizontal,
  type LucideIcon,
} from 'lucide-react'
import { LayoutService } from '../services/layout.service'
import type { RightPanelTab } from '../services/layout'
import { IconButton } from './button'
import { ChatPanel } from './chat-panel'
import { GitPanel } from './git-panel-host'
import { PropertiesPanel } from './properties-panel'
import { TocPanel } from './toc-panel'

const PANEL_TABS: { id: RightPanelTab; label: string; icon: LucideIcon }[] = [
  { id: 'properties', label: 'Properties', icon: SlidersHorizontal },
  { id: 'toc', label: 'Outline', icon: List },
  { id: 'git', label: 'Git', icon: GitBranch },
  { id: 'chat', label: 'Agent', icon: MessageCircle },
]

const TabButton = observer(function TabButton({ tab, collapsed }: { tab: (typeof PANEL_TABS)[number]; collapsed: boolean }) {
  const layout = useService(LayoutService)
  const active = !collapsed && layout.rightPanelTab === tab.id
  return (
    <IconButton
      key={tab.id}
      icon={tab.icon}
      label={tab.label}
      active={active}
      className="panel-tab"
      data-testid={`panel-tab-${tab.id}`}
      data-panel={tab.id}
      role="tab"
      aria-selected={active}
      title={tab.label}
      onClick={() => {
        if (!collapsed && layout.rightPanelTab === tab.id) layout.setRightPanelCollapsed(true)
        else layout.setRightPanelTab(tab.id)
      }}
    />
  )
})

const PanelTabs = observer(function PanelTabs({ collapsed }: { collapsed: boolean }) {
  return (
    <div className="panel-tabs" role="tablist" aria-label="Inspector panels">
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
  const layout = useService(LayoutService)
  return (
    <div className="panel-wrap" data-testid="right-panel">
      <div className="panel-head">
        <PanelTabs collapsed={false} />
        <IconButton
          icon={PanelRightClose}
          label="Hide panel"
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
