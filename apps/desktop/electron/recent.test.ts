import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { RecentProject } from '@stride/electron-api'
import {
  defaultMenuCopy,
  folderTitle,
  loadRecentFile,
  menuSignature,
  normalizePath,
  parentLabel,
  parseRecent,
  pathFromMenuId,
  prepareRecent,
  projectWindowTitle,
  recentMenuId,
  recentMenuLabels,
  RECENT_LIMIT,
  saveRecentFile,
} from './recent.ts'

function project(path: string, title: string, opened: string): RecentProject {
  return { id: path, path, title, lastOpened: opened }
}

describe('recent projects', () => {
  it('normalizes separators and keeps a drive root', () => {
    expect(normalizePath('/Users/a/notes/')).toBe('/Users/a/notes')
    expect(normalizePath('C:\\Users\\notes\\')).toBe('C:/Users/notes')
    expect(normalizePath('C:/')).toBe('C:/')
    expect(folderTitle('/Users/a/notes')).toBe('notes')
    expect(folderTitle('C:/Users/notes')).toBe('notes')
    expect(parentLabel('/Users/a/notes')).toBe('a')
    expect(parentLabel('/notes')).toBeNull()
    expect(projectWindowTitle('/Users/a/notes')).toBe('notes — Stride')
    expect(projectWindowTitle(null)).toBe('Stride')
  })

  it('round-trips menu ids from the normalized path', () => {
    expect(recentMenuId('/Users/a/notes/')).toBe('recent:/Users/a/notes')
    expect(pathFromMenuId('recent:/Users/a/notes')).toBe('/Users/a/notes')
    expect(pathFromMenuId('file.new-window')).toBeNull()
    expect(pathFromMenuId('recent:')).toBeNull()
  })

  it('keeps the newest unique paths up to ten', () => {
    const projects = [
      project('/vaults/old/', 'old', '2026-01-01T00:00:00.000Z'),
      project('/vaults/old', 'older-name', '2026-01-02T00:00:00.000Z'),
      project('C:\\vaults\\win\\', '', '2026-03-01T00:00:00.000Z'),
    ]
    for (let index = 0; index < 8; index += 1) {
      projects.push(project(`/vaults/n${index}`, `n${index}`, `2026-02-0${index}T00:00:00.000Z`))
    }
    const prepared = prepareRecent(projects)
    expect(prepared).toHaveLength(RECENT_LIMIT)
    expect(prepared[0]?.path).toBe('C:/vaults/win')
    expect(prepared[0]?.title).toBe('win')
    expect(prepared.some((item) => item.path === '/vaults/old' && item.title === 'older-name')).toBe(true)
    expect(prepared.every((item, index) => index === 0 || item.lastOpened <= prepared[index - 1]!.lastOpened)).toBe(true)
  })

  it('disambiguates duplicate folder names with the parent', () => {
    expect(recentMenuLabels([
      project('/work/a/notes', 'notes', '2026-02-01T00:00:00.000Z'),
      project('/work/b/notes', 'notes', '2026-01-01T00:00:00.000Z'),
      project('/work/solo', 'solo', '2026-03-01T00:00:00.000Z'),
    ])).toEqual(['notes — a', 'notes — b', 'solo'])
  })

  it('rejects corrupt files and rewrites a prepared list', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stride-recent-'))
    try {
      await writeFile(join(root, 'recent-projects.json'), '{', 'utf8')
      expect(loadRecentFile(root)).toEqual([])
      expect(parseRecent('null')).toEqual([])
      saveRecentFile(root, prepareRecent([
        project('/tmp/stride-e05a-not-a-vault/alpha/', '', '2026-04-01T00:00:00.000Z'),
      ]))
      expect(await readFile(join(root, 'recent-projects.json'), 'utf8')).toContain('/tmp/stride-e05a-not-a-vault/alpha')
      const loaded = loadRecentFile(root)
      const copy = defaultMenuCopy()
      expect(menuSignature(loaded, copy)).toContain('/tmp/stride-e05a-not-a-vault/alpha')
      const opened = loaded[0]!
      const later = { ...opened, lastOpened: '2026-05-01T00:00:00.000Z' }
      expect(menuSignature([later], copy)).not.toBe(menuSignature([opened], copy))
      saveRecentFile(root, [later])
      expect(loadRecentFile(root)[0]?.lastOpened).toBe(later.lastOpened)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
