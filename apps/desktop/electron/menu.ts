import { app, Menu, type MenuItemConstructorOptions } from 'electron'
import type { MenuCopy, RecentProject, WindowIntent } from '@stride/electron-api'
import { buildDockModel, buildMenuModel, type MenuNode } from './menu-model.ts'
import { pathFromMenuId } from './recent.ts'

export interface MenuController {
  apply(projects: RecentProject[], copy: MenuCopy): void
  closeFocused(): void
  zoomFocused(): void
}

function toTemplate(nodes: readonly MenuNode[], onId: (id: string) => void): MenuItemConstructorOptions[] {
  return nodes.map((node) => {
    const item: MenuItemConstructorOptions = {}
    if (node.type === 'separator') return { type: 'separator' }
    if (node.role) item.role = node.role as MenuItemConstructorOptions['role']
    if (node.label) item.label = node.label
    if (node.id) item.id = node.id
    if (node.accelerator) item.accelerator = node.accelerator
    if (node.enabled === false) item.enabled = false
    if (node.submenu) {
      item.submenu = toTemplate(node.submenu, onId)
    } else if (node.id && !node.role) {
      item.click = () => onId(node.id!)
    }
    return item
  })
}

export function installApplicationMenu(actions: {
  deliver(intent: WindowIntent): void
  clearRecent(): void
  closeFocused(): void
  zoomFocused(): void
}): MenuController {
  function onId(id: string): void {
    if (id === 'file.new-window') {
      actions.deliver({ kind: 'fresh' })
      return
    }
    if (id === 'file.new-project') {
      actions.deliver({ kind: 'pick-create' })
      return
    }
    if (id === 'file.open-project') {
      actions.deliver({ kind: 'pick-open' })
      return
    }
    if (id === 'file.close-window') {
      actions.closeFocused()
      return
    }
    if (id === 'file.clear-recent') {
      actions.clearRecent()
      return
    }
    if (id === 'window.zoom') {
      actions.zoomFocused()
      return
    }
    const path = pathFromMenuId(id)
    if (path) actions.deliver({ kind: 'open', path })
  }

  function apply(projects: RecentProject[], copy: MenuCopy): void {
    const menu = Menu.buildFromTemplate(toTemplate(buildMenuModel(copy, projects, process.platform), onId))
    Menu.setApplicationMenu(menu)
    if (process.platform !== 'darwin' || !app.dock) return
    const dock = Menu.buildFromTemplate(toTemplate(buildDockModel(copy, projects), onId))
    app.dock.setMenu(dock)
  }

  return {
    apply,
    closeFocused: actions.closeFocused,
    zoomFocused: actions.zoomFocused,
  }
}
