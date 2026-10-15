import { has, register, Service } from '@rabjs/react'
import {
  clampColumnWidth,
  DEFAULT_LAYOUT_STATE,
  readLayoutState,
  writeLayoutState,
  type LayoutState,
  type LayoutStorage,
  type ResizableColumn,
  type RightPanelTab,
} from './layout'

function layoutStorage(): LayoutStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

export class LayoutService extends Service {
  sidebarWidth = DEFAULT_LAYOUT_STATE.sidebarWidth
  noteListWidth = DEFAULT_LAYOUT_STATE.noteListWidth
  rightPanelWidth = DEFAULT_LAYOUT_STATE.rightPanelWidth
  sidebarCollapsed = DEFAULT_LAYOUT_STATE.sidebarCollapsed
  rightPanelCollapsed = DEFAULT_LAYOUT_STATE.rightPanelCollapsed
  rightPanelTab: RightPanelTab = DEFAULT_LAYOUT_STATE.rightPanelTab

  constructor() {
    super()
    const stored = readLayoutState(layoutStorage())
    this.sidebarWidth = stored.sidebarWidth
    this.noteListWidth = stored.noteListWidth
    this.rightPanelWidth = stored.rightPanelWidth
    this.sidebarCollapsed = stored.sidebarCollapsed
    this.rightPanelCollapsed = stored.rightPanelCollapsed
    this.rightPanelTab = stored.rightPanelTab
  }

  setColumnWidth(column: ResizableColumn, width: number) {
    const clamped = clampColumnWidth(column, width)
    if (column === 'sidebar') this.sidebarWidth = clamped
    else if (column === 'noteList') this.noteListWidth = clamped
    else this.rightPanelWidth = clamped
    this.persist()
  }

  setSidebarCollapsed(collapsed: boolean) {
    this.sidebarCollapsed = collapsed
    this.persist()
  }

  toggleSidebar() {
    this.setSidebarCollapsed(!this.sidebarCollapsed)
  }

  setRightPanelCollapsed(collapsed: boolean) {
    this.rightPanelCollapsed = collapsed
    this.persist()
  }

  toggleRightPanel() {
    this.setRightPanelCollapsed(!this.rightPanelCollapsed)
  }

  /** Selecting a tab always expands the panel so the choice is visible. */
  setRightPanelTab(tab: RightPanelTab) {
    this.rightPanelTab = tab
    this.rightPanelCollapsed = false
    this.persist()
  }

  private snapshot(): LayoutState {
    return {
      sidebarWidth: this.sidebarWidth,
      noteListWidth: this.noteListWidth,
      rightPanelWidth: this.rightPanelWidth,
      sidebarCollapsed: this.sidebarCollapsed,
      rightPanelCollapsed: this.rightPanelCollapsed,
      rightPanelTab: this.rightPanelTab,
    }
  }

  private persist() {
    writeLayoutState(layoutStorage(), this.snapshot())
  }
}

// Tests mount the workspace without main.tsx, so the global service must exist on import.
if (!has(LayoutService)) register(LayoutService)
