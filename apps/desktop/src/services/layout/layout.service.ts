import { has, register, Service } from '@rabjs/react'
import {
  clampColumnWidth,
  DEFAULT_LAYOUT_STATE,
  readLayoutState,
  writeLayoutState,
  type LayoutState,
  type LayoutStorage,
  type RailCollapsed,
  type RailSection,
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
  railCollapsed: RailCollapsed = { ...DEFAULT_LAYOUT_STATE.railCollapsed }
  foldersCollapsed: Record<string, boolean> = {}
  /** Note the folder tree should scroll to. Transient; not persisted. */
  revealedNoteId = ''
  /** Folder row the tree should scroll to when no note is targeted. */
  revealedFolderPath = ''
  /** Bumped on every reveal so repeating the same target still scrolls. */
  revealSeq = 0

  constructor() {
    super()
    const stored = readLayoutState(layoutStorage())
    this.sidebarWidth = stored.sidebarWidth
    this.noteListWidth = stored.noteListWidth
    this.rightPanelWidth = stored.rightPanelWidth
    this.sidebarCollapsed = stored.sidebarCollapsed
    this.rightPanelCollapsed = stored.rightPanelCollapsed
    this.rightPanelTab = stored.rightPanelTab
    this.railCollapsed = stored.railCollapsed
    this.foldersCollapsed = stored.foldersCollapsed
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

  /** Rail group collapse (views / types / notes). UI state, kept out of the vault. */
  setRailSectionCollapsed(section: RailSection, collapsed: boolean) {
    this.railCollapsed = { ...this.railCollapsed, [section]: collapsed }
    this.persist()
  }

  toggleRailSection(section: RailSection) {
    this.setRailSectionCollapsed(section, !this.railCollapsed[section])
  }

  /** Folder collapse in the notes tree. UI state, kept out of the vault. */
  isFolderCollapsed(path: string) {
    return this.foldersCollapsed[path] === true
  }

  /** Expanded folders are pruned from the record, so storage stays clean. */
  setFolderCollapsed(path: string, collapsed: boolean) {
    const next = { ...this.foldersCollapsed }
    if (collapsed) next[path] = true
    else delete next[path]
    this.foldersCollapsed = next
    this.persist()
  }

  toggleFolder(path: string) {
    this.setFolderCollapsed(path, !this.isFolderCollapsed(path))
  }

  /**
   * Open the sidebar, the notes group, and each folder in `folders` so a
   * context-menu reveal can scroll the target into view. One persist.
   */
  showInTree(folders: readonly string[], target: { noteId: string } | { folderPath: string }) {
    const next = { ...this.foldersCollapsed }
    let folderChanged = false
    for (const path of folders) {
      if (!next[path]) continue
      delete next[path]
      folderChanged = true
    }
    if (folderChanged) this.foldersCollapsed = next
    let changed = folderChanged
    if (this.sidebarCollapsed) {
      this.sidebarCollapsed = false
      changed = true
    }
    if (this.railCollapsed.notes) {
      this.railCollapsed = { ...this.railCollapsed, notes: false }
      changed = true
    }
    if ('noteId' in target) {
      this.revealedNoteId = target.noteId
      this.revealedFolderPath = ''
    } else {
      this.revealedNoteId = ''
      this.revealedFolderPath = target.folderPath
    }
    this.revealSeq += 1
    if (changed) this.persist()
  }

  private snapshot(): LayoutState {
    return {
      sidebarWidth: this.sidebarWidth,
      noteListWidth: this.noteListWidth,
      rightPanelWidth: this.rightPanelWidth,
      sidebarCollapsed: this.sidebarCollapsed,
      rightPanelCollapsed: this.rightPanelCollapsed,
      rightPanelTab: this.rightPanelTab,
      railCollapsed: this.railCollapsed,
      foldersCollapsed: this.foldersCollapsed,
    }
  }

  private persist() {
    writeLayoutState(layoutStorage(), this.snapshot())
  }
}

// Tests mount the workspace without main.tsx, so the global service must exist on import.
if (!has(LayoutService)) register(LayoutService)
