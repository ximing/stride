import type { MenuCopy, RecentProject } from '@stride/electron-api'
import {
  ID_CLEAR_RECENT,
  ID_CLOSE_WINDOW,
  ID_NEW_PROJECT,
  ID_NEW_WINDOW,
  ID_OPEN_PROJECT,
  ID_OPEN_RECENT,
  ID_RECENT_EMPTY,
  recentMenuId,
  recentMenuLabels,
} from './recent.ts'

export interface MenuNode {
  id?: string
  label?: string
  accelerator?: string
  enabled?: boolean
  type?: 'normal' | 'separator' | 'submenu'
  role?: string
  submenu?: MenuNode[]
}

export function buildMenuModel(
  copy: MenuCopy,
  projects: readonly RecentProject[],
  platform: NodeJS.Platform,
): MenuNode[] {
  const recentItems: MenuNode[] = []
  const labels = recentMenuLabels(projects)
  if (projects.length === 0) {
    recentItems.push({ id: ID_RECENT_EMPTY, label: copy.emptyRecent, enabled: false })
  } else {
    projects.forEach((project, index) => {
      recentItems.push({
        id: recentMenuId(project.path),
        label: labels[index] ?? project.title,
        enabled: true,
      })
    })
  }
  recentItems.push({ type: 'separator' })
  recentItems.push({ id: ID_CLEAR_RECENT, label: copy.clearRecent, enabled: true })

  const file: MenuNode = {
    id: 'file',
    label: copy.file,
    type: 'submenu',
    submenu: [
      { id: ID_NEW_WINDOW, label: copy.newWindow, accelerator: 'CmdOrCtrl+N', enabled: true },
      { id: ID_NEW_PROJECT, label: copy.newProject, enabled: true },
      { id: ID_OPEN_PROJECT, label: copy.openProject, accelerator: 'CmdOrCtrl+O', enabled: true },
      { type: 'separator' },
      { id: ID_OPEN_RECENT, label: copy.openRecent, type: 'submenu', submenu: recentItems },
      { type: 'separator' },
      { id: ID_CLOSE_WINDOW, label: copy.closeWindow, accelerator: 'CmdOrCtrl+W', enabled: true },
    ],
  }
  if (platform !== 'darwin') file.submenu?.push({ role: 'quit' })

  const edit: MenuNode = {
    label: 'Edit',
    type: 'submenu',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { role: 'selectAll' },
    ],
  }

  const windowMenu: MenuNode = {
    id: 'window',
    label: 'Window',
    role: 'window',
    type: 'submenu',
    submenu: [
      { role: 'minimize' },
      platform === 'darwin' ? { role: 'zoom' } : { id: 'window.zoom', label: 'Zoom', enabled: true },
    ],
  }

  const items: MenuNode[] = []
  if (platform === 'darwin') {
    items.push({
      label: 'Stride',
      type: 'submenu',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    })
  }
  items.push(file, edit)
  if (platform === 'darwin') {
    items.push({
      label: 'View',
      type: 'submenu',
      submenu: [{ role: 'togglefullscreen' }],
    })
  }
  items.push(windowMenu)
  items.push({
    id: 'help',
    label: 'Help',
    role: 'help',
    type: 'submenu',
    submenu: platform === 'darwin' ? [] : [{ role: 'about' }],
  })
  return items
}

export function buildDockModel(copy: MenuCopy, projects: readonly RecentProject[]): MenuNode[] {
  const items: MenuNode[] = [
    { id: ID_NEW_WINDOW, label: copy.newWindow, enabled: true },
    { type: 'separator' },
  ]
  if (projects.length === 0) {
    items.push({ id: ID_RECENT_EMPTY, label: copy.emptyRecent, enabled: false })
    return items
  }
  const labels = recentMenuLabels(projects)
  projects.forEach((project, index) => {
    items.push({
      id: recentMenuId(project.path),
      label: labels[index] ?? project.title,
      enabled: true,
    })
  })
  return items
}
