// Collapsible rail group header: chevron + group label on the left, a
// hover/focus-revealed create action (usually a Plus IconButton) on the
// right. Collapse state lives in LayoutService (`stride:layout`), not here.
import { ChevronDown, ChevronRight } from 'lucide-react'
import type { ReactNode } from 'react'
import { Mark } from '../primitives/icon'

export interface RailGroupHeaderProps {
  title: string
  collapsed: boolean
  onToggle: () => void
  /** Create affordance pinned right; revealed on hover/focus-within. */
  action?: ReactNode
  testId?: string
}

export function RailGroupHeader({ title, collapsed, onToggle, action, testId }: RailGroupHeaderProps) {
  return (
    <div className="rail-group-head" data-testid={testId} data-collapsed={collapsed ? 'true' : undefined}>
      <button
        type="button"
        className="rail-group-toggle"
        aria-expanded={!collapsed}
        aria-label={title}
        onClick={onToggle}
      >
        <span className="rail-group-chevron">
          <Mark icon={collapsed ? ChevronRight : ChevronDown} size={16} />
        </span>
        <span className="group-label rail-group-title">{title}</span>
      </button>
      {action ? <span className="rail-group-action">{action}</span> : null}
    </div>
  )
}
