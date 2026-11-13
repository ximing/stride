import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { MenuCopy, RecentProject } from '@stride/electron-api'

export const RECENT_LIMIT = 10
export const RECENT_FILE_NAME = 'recent-projects.json'
export const ID_NEW_WINDOW = 'file.new-window'
export const ID_NEW_PROJECT = 'file.new-project'
export const ID_OPEN_PROJECT = 'file.open-project'
export const ID_CLOSE_WINDOW = 'file.close-window'
export const ID_CLEAR_RECENT = 'file.clear-recent'
export const ID_RECENT_EMPTY = 'file.recent-empty'
export const ID_OPEN_RECENT = 'file.open-recent'

export function defaultMenuCopy(): MenuCopy {
  return {
    file: 'File',
    newWindow: 'New Window',
    newProject: 'New Project…',
    openProject: 'Open Project…',
    openRecent: 'Open Recent',
    clearRecent: 'Clear Recently Opened',
    closeWindow: 'Close Window',
    emptyRecent: 'No Recent Projects',
  }
}

export function normalizePath(path: string): string {
  let value = path.replaceAll('\\', '/')
  const drive = value.length >= 2 && /^[A-Za-z]:/.test(value)
  while (value.length > 1 && value.endsWith('/')) {
    if (drive && value.length === 3) break
    value = value.slice(0, -1)
  }
  return value
}

export function folderTitle(path: string): string {
  const normalized = normalizePath(path)
  const name = normalized.split('/').pop()
  if (name) return name
  return path
}

export function parentLabel(path: string): string | null {
  const normalized = normalizePath(path)
  const slash = normalized.lastIndexOf('/')
  if (slash <= 0) return null
  const parent = normalized.slice(0, slash)
  if (!parent) return null
  return folderTitle(parent)
}

export function projectWindowTitle(path: string | null): string {
  if (!path) return 'Stride'
  return `${folderTitle(path)} — Stride`
}

export function recentMenuId(path: string): string {
  return `recent:${normalizePath(path)}`
}

export function pathFromMenuId(id: string): string | null {
  if (!id.startsWith('recent:')) return null
  const path = id.slice('recent:'.length)
  return path ? path : null
}

export function prepareRecent(projects: RecentProject[]): RecentProject[] {
  const best: RecentProject[] = []
  for (const input of projects) {
    const path = normalizePath(input.path)
    if (!path) continue
    const project: RecentProject = {
      id: input.id,
      path,
      title: input.title || folderTitle(path),
      lastOpened: input.lastOpened,
    }
    const existing = best.find((item) => item.path === project.path)
    if (existing) {
      if (project.lastOpened >= existing.lastOpened) {
        existing.id = project.id
        existing.title = project.title
        existing.lastOpened = project.lastOpened
      }
      continue
    }
    best.push(project)
  }
  best.sort((left, right) => {
    if (left.lastOpened === right.lastOpened) return left.path < right.path ? -1 : left.path > right.path ? 1 : 0
    return left.lastOpened < right.lastOpened ? 1 : -1
  })
  return best.slice(0, RECENT_LIMIT)
}

export function recentMenuLabels(projects: readonly RecentProject[]): string[] {
  const titles = projects.map((project) => project.title || folderTitle(project.path))
  const counts = new Map<string, number>()
  for (const title of titles) counts.set(title, (counts.get(title) ?? 0) + 1)
  return titles.map((title, index) => {
    if ((counts.get(title) ?? 0) <= 1) return title
    const parent = parentLabel(projects[index]?.path ?? '')
    return parent ? `${title} — ${parent}` : title
  })
}

export function menuSignature(projects: readonly RecentProject[], copy: MenuCopy): string {
  const parts = [
    copy.file,
    copy.newWindow,
    copy.newProject,
    copy.openProject,
    copy.openRecent,
    copy.clearRecent,
    copy.closeWindow,
    copy.emptyRecent,
  ]
  for (const project of projects) {
    parts.push(project.path, project.title, project.id, project.lastOpened)
  }
  return parts.join('\u0001')
}

function isProject(value: unknown): value is RecentProject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const project = value as Partial<RecentProject>
  return typeof project.id === 'string'
    && typeof project.path === 'string'
    && typeof project.title === 'string'
    && typeof project.lastOpened === 'string'
}

export function parseRecent(raw: string): RecentProject[] {
  try {
    const value: unknown = JSON.parse(raw)
    if (!Array.isArray(value)) return []
    return prepareRecent(value.filter(isProject))
  } catch {
    return []
  }
}

export function recentJson(projects: readonly RecentProject[]): string {
  return JSON.stringify(projects)
}

const COPY_FIELDS = [
  'file',
  'newWindow',
  'newProject',
  'openProject',
  'openRecent',
  'clearRecent',
  'closeWindow',
  'emptyRecent',
] as const

export function parseMenuCopy(value: unknown): MenuCopy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Rejected invalid menu copy')
  }
  const record = value as Record<string, unknown>
  const copy = {} as MenuCopy
  for (const field of COPY_FIELDS) {
    const item = record[field]
    if (typeof item !== 'string') throw new Error('Rejected invalid menu copy')
    copy[field] = item
  }
  return copy
}

export function parseRecentProjects(value: unknown): RecentProject[] {
  if (!Array.isArray(value)) throw new Error('Rejected invalid recent projects')
  const projects: RecentProject[] = []
  for (const item of value) {
    if (!isProject(item)) throw new Error('Rejected invalid recent projects')
    projects.push(item)
  }
  return projects
}

export function recentFilePath(userData: string): string {
  return join(userData, RECENT_FILE_NAME)
}

export function loadRecentFile(userData: string): RecentProject[] {
  try {
    return parseRecent(readFileSync(recentFilePath(userData), 'utf8'))
  } catch {
    return []
  }
}

export function saveRecentFile(userData: string, projects: readonly RecentProject[]): void {
  const path = recentFilePath(userData)
  mkdirSync(userData, { recursive: true })
  writeFileSync(path, recentJson(projects), 'utf8')
}
