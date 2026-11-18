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
import { readFolderTreeState, writeFolderTreeState } from './folder-tree-state'

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
  foldersExpanded: Record<string, boolean> = {}
  treeVaultId = ''
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

  /** Switch only once the vault identity has been committed by the open pipeline. */
  setTreeVault(vaultId: string) {
    if (this.treeVaultId === vaultId) return
    this.treeVaultId = vaultId
    this.foldersExpanded = readFolderTreeState(layoutStorage(), vaultId)
    this.revealedNoteId = ''
    this.revealedFolderPath = ''
    this.revealSeq = 0
  }

  isFolderCollapsed(path: string) {
    return this.foldersExpanded[path] !== true
  }

  setFolderCollapsed(path: string, collapsed: boolean) {
    const next = { ...this.foldersExpanded, [path]: true }
    if (collapsed) delete next[path]
    this.foldersExpanded = next
    this.persistTree()
  }

  toggleFolder(path: string) {
    this.setFolderCollapsed(path, !this.isFolderCollapsed(path))
  }

  collapseAllFolders() {
    this.foldersExpanded = {}
    this.revealedNoteId = ''
    this.revealedFolderPath = ''
    this.persistTree()
  }

  expandFolders(paths: readonly string[]) {
    this.foldersExpanded = { ...this.foldersExpanded, ...Object.fromEntries(paths.map(path => [path, true])) }
    this.persistTree()
  }

  /** Rename/move a complete subtree, including hidden descendants. */
  remapFolder(from: string, to: string) {
    const remap = (path: string) => path === from || path.startsWith(`${from}/`) ? to + path.slice(from.length) : path
    this.foldersExpanded = Object.fromEntries(Object.entries(this.foldersExpanded).map(([path, flag]) => [remap(path), flag]))
    this.revealedFolderPath = remap(this.revealedFolderPath)
    this.revealedNoteId = remap(this.revealedNoteId)
    this.persistTree()
  }

  forgetFolder(path: string) {
    const inside = (value: string) => value === path || value.startsWith(`${path}/`)
    this.foldersExpanded = Object.fromEntries(Object.entries(this.foldersExpanded).filter(([key]) => !inside(key)))
    if (inside(this.revealedNoteId)) this.revealedNoteId = ''
    if (inside(this.revealedFolderPath)) this.revealedFolderPath = ''
    this.persistTree()
  }

  /** Explicit reveal opens the sidebar; navigation reveal respects hidden panels. */
  showInTree(folders: readonly string[], target: { noteId: string } | { folderPath: string }, explicit = true) {
    if (!explicit && (this.sidebarCollapsed || this.railCollapsed.notes)) return
    this.expandFolders(folders)
    if (explicit) {
      this.sidebarCollapsed = false
      this.railCollapsed = { ...this.railCollapsed, notes: false }
      this.persist()
    }
    this.revealedNoteId = 'noteId' in target ? target.noteId : ''
    this.revealedFolderPath = 'folderPath' in target ? target.folderPath : ''
    this.revealSeq += 1
  }

  private persistTree() {
    writeFolderTreeState(layoutStorage(), this.treeVaultId, this.foldersExpanded)
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
    }
  }

  private persist() {
    writeLayoutState(layoutStorage(), this.snapshot())
  }
}

// Tests mount the workspace without main.tsx, so the global service must exist on import.
if (!has(LayoutService)) register(LayoutService)
