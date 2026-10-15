import type { Icon } from '@phosphor-icons/react'
import { ChatCircle } from '@phosphor-icons/react/ChatCircle'
import { GitBranch } from '@phosphor-icons/react/GitBranch'
import { ListBullets } from '@phosphor-icons/react/ListBullets'
import { CaretLineRight } from '@phosphor-icons/react/CaretLineRight'
import { SlidersHorizontal } from '@phosphor-icons/react/SlidersHorizontal'
import { observer, useService } from '@rabjs/react'
import { LayoutService } from '../services/layout.service'
import type { RightPanelTab } from '../services/layout'
import { ChatPanel } from './chat-panel'
import { GitPanel } from './git-panel-host'
import { Mark } from './icon'
import { PropertiesPanel } from './properties-panel'
import { TocPanel } from './toc-panel'

const PANEL_TABS: { id: RightPanelTab; label: string; icon: Icon }[] = [
  { id: 'properties', label: 'Properties', icon: SlidersHorizontal },
  { id: 'toc', label: 'Outline', icon: ListBullets },
  { id: 'git', label: 'Git', icon: GitBranch },
  { id: 'chat', label: 'Agent', icon: ChatCircle },
]

const TabButton = observer(function TabButton({ tab, collapsed }: { tab: (typeof PANEL_TABS)[number]; collapsed: boolean }) {
  const layout = useService(LayoutService)
  const active = !collapsed && layout.rightPanelTab === tab.id
  return (
    <button
      key={tab.id}
      type="button"
      className="panel-tab"
      data-testid={`panel-tab-${tab.id}`}
      data-panel={tab.id}
      role="tab"
      aria-selected={active}
      title={tab.label}
      aria-label={tab.label}
      onClick={() => {
        if (!collapsed && layout.rightPanelTab === tab.id) layout.setRightPanelCollapsed(true)
        else layout.setRightPanelTab(tab.id)
      }}
    >
      <Mark icon={tab.icon} size={17} />
    </button>
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
        <button
          type="button"
          className="panel-tab panel-collapse"
          data-testid="panel-collapse"
          aria-label="Hide panel"
          onClick={() => layout.setRightPanelCollapsed(true)}
        >
          <Mark icon={CaretLineRight} size={17} />
        </button>
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
