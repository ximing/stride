import { describe, expect, it } from 'vitest'
import {
  folderTitle,
  mergeVaultRecords,
  recentProjectsFromRecords,
  reconcileRegistry,
  type RecentProject,
} from './vault-registry'
import type { VaultRecord } from './vault.service'

function vault(id: string, label: string, lastOpened: string, color = '', icon = ''): VaultRecord {
  return { id, label, color, icon, lastOpened }
}

describe('mergeVaultRecords', () => {
  it('keeps stored order and lets a newer local stamp replace fields', () => {
    const stored = [vault('remote', '/Users/remote', '2026-01-01T00:00:00.000Z')]
    const local = [
      vault('remote', '/Users/remote', '2026-03-01T00:00:00.000Z', '#abc', 'book'),
      vault('local', '/Users/local', '2026-02-01T00:00:00.000Z'),
    ]
    expect(mergeVaultRecords(local, stored).map((entry) => entry.id)).toEqual(['remote', 'local'])
    expect(mergeVaultRecords(local, stored)[0]).toEqual(local[0])
  })

  it('keeps an older local record when the stored stamp is newer', () => {
    const stored = [vault('shared', '/Users/shared', '2026-05-01T00:00:00.000Z', '#new', 'new')]
    const local = [vault('shared', '/Users/shared', '2026-01-01T00:00:00.000Z', '#old', 'old')]
    expect(mergeVaultRecords(local, stored)).toEqual(stored)
  })
})

describe('reconcileRegistry', () => {
  it('follows incoming membership and keeps a newer local copy', () => {
    const local = [
      vault('kept', '/Users/kept', '2026-04-01T00:00:00.000Z', '#local', 'book'),
      vault('dropped', '/Users/dropped', '2026-01-01T00:00:00.000Z'),
    ]
    const incoming = [
      vault('kept', '/Users/kept', '2026-02-01T00:00:00.000Z', '#remote', 'folder'),
      vault('added', '/Users/added', '2026-03-01T00:00:00.000Z'),
    ]
    expect(reconcileRegistry(local, incoming)).toEqual([
      vault('kept', '/Users/kept', '2026-04-01T00:00:00.000Z', '#local', 'book'),
      vault('added', '/Users/added', '2026-03-01T00:00:00.000Z'),
    ])
  })

  it('uses the incoming record when the stamps are equal', () => {
    const stamp = '2026-01-01T00:00:00.000Z'
    const local = [vault('same', '/Users/local', stamp, '#local', 'a')]
    const incoming = [vault('same', '/Users/incoming', stamp, '#incoming', 'b')]
    expect(reconcileRegistry(local, incoming)).toEqual(incoming)
  })
})

describe('folderTitle', () => {
  it('uses the last path segment and falls back to the original label', () => {
    expect(folderTitle('/Users/a/notes/')).toBe('notes')
    expect(folderTitle('C:\\Users\\notes')).toBe('notes')
    expect(folderTitle('Notes')).toBe('Notes')
    expect(folderTitle('/')).toBe('/')
  })
})

describe('recentProjectsFromRecords', () => {
  it('keeps absolute paths, newest first, and caps the list', () => {
    const records = [
      vault('rel', 'Notes', '2026-08-01T00:00:00.000Z'),
      vault('old', '/vaults/old', '2026-01-01T00:00:00.000Z'),
      ...Array.from({ length: 10 }, (_, index) => vault(
        `n${index}`,
        `/vaults/n${index}`,
        `2026-02-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
      )),
      vault('new', '/vaults/new', '2026-06-01T00:00:00.000Z'),
    ]
    const projects = recentProjectsFromRecords(records)
    expect(projects).toHaveLength(10)
    expect(projects.map((project: RecentProject) => project.id)).toEqual([
      'new', 'n9', 'n8', 'n7', 'n6', 'n5', 'n4', 'n3', 'n2', 'n1',
    ])
    expect(projects[0]).toEqual({
      id: 'new',
      path: '/vaults/new',
      title: 'new',
      lastOpened: '2026-06-01T00:00:00.000Z',
    })
    expect(projects.some((project) => project.id === 'rel' || project.id === 'old')).toBe(false)
  })
})
