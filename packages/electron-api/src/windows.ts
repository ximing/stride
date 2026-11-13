/** Startup or menu action for one BrowserWindow. `kind` is the BrowserWindow intent. */
export type WindowIntent =
  | { kind: 'restore' }
  | { kind: 'fresh' }
  | { kind: 'open'; path: string }
  | { kind: 'pick-open' }
  | { kind: 'pick-create' }

/** One row of the native Open Recent list. */
export interface RecentProject {
  id: string
  path: string
  title: string
  lastOpened: string
}

/**
 * File menu labels supplied by the renderer.
 * Field names are the recent-project contract.
 */
export interface MenuCopy {
  file: string
  newWindow: string
  newProject: string
  openProject: string
  openRecent: string
  clearRecent: string
  closeWindow: string
  emptyRecent: string
}

export interface SyncRecentRequest {
  projects: RecentProject[]
  copy: MenuCopy
}

export interface SetProjectRequest {
  path?: string | null
}
