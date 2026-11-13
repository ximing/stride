import { describe, expect, it } from 'vitest'
import type { MenuCopy, RecentProject } from '@stride/electron-api'
import { buildDockModel, buildMenuModel } from './menu-model.ts'

const copy: MenuCopy = {
  file: 'File',
  newWindow: 'New Window',
  newProject: 'New Project…',
  openProject: 'Open Project…',
  openRecent: 'Open Recent',
  clearRecent: 'Clear Recently Opened',
  closeWindow: 'Close Window',
  emptyRecent: 'No Recent Projects',
}

function project(path: string, title: string): RecentProject {
  return { id: path, path, title, lastOpened: '2026-04-01T00:00:00.000Z' }
}

describe('menu model', () => {
  it('uses the renderer copy and the Electron accelerators', () => {
    const model = buildMenuModel(copy, [], 'darwin')
    const file = model.find((item) => item.id === 'file')
    expect(file?.label).toBe('File')
    expect(file?.submenu?.map((item) => item.accelerator).filter(Boolean)).toEqual([
      'CmdOrCtrl+N',
      'CmdOrCtrl+O',
      'CmdOrCtrl+W',
    ])
    const recent = file?.submenu?.find((item) => item.id === 'file.open-recent')
    expect(recent?.submenu?.[0]).toMatchObject({ id: 'file.recent-empty', label: 'No Recent Projects', enabled: false })
    expect(recent?.submenu?.some((item) => item.id === 'file.clear-recent')).toBe(true)
    expect(model.some((item) => item.label === 'View')).toBe(true)
    expect(model.find((item) => item.label === 'Window')?.submenu?.map((item) => item.role)).toEqual([
      'minimize',
      'zoom',
    ])
    expect(model.find((item) => item.label === 'Edit')?.submenu?.map((item) => item.role).filter(Boolean)).toEqual([
      'undo',
      'redo',
      'cut',
      'copy',
      'paste',
      'selectAll',
    ])
  })

  it('labels duplicate recent folders with their parent and skips the dock off mac', () => {
    const projects = [
      project('/tmp/stride-e05a-not-a-vault/a/notes', 'notes'),
      project('/tmp/stride-e05a-not-a-vault/b/notes', 'notes'),
    ]
    const recent = buildMenuModel(copy, projects, 'linux')
      .find((item) => item.id === 'file')
      ?.submenu?.find((item) => item.id === 'file.open-recent')
    expect(recent?.submenu?.map((item) => item.label).filter(Boolean)).toEqual([
      'notes — a',
      'notes — b',
      'Clear Recently Opened',
    ])
    expect(buildMenuModel(copy, projects, 'linux').some((item) => item.label === 'View')).toBe(false)
    expect(buildDockModel(copy, projects).map((item) => item.label).filter(Boolean)).toEqual([
      'New Window',
      'notes — a',
      'notes — b',
    ])
  })
})
