import { beforeEach, describe, expect, it } from 'vitest'
import { FOLDER_TREE_STORAGE_PREFIX, readFolderTreeState, writeFolderTreeState } from './folder-tree-state'
import { LayoutService } from './layout.service'

beforeEach(() => localStorage.clear())

describe('vault folder tree state', () => {
  it('starts folded, ignores the old global record, and persists each vault independently', () => {
    localStorage.setItem('stride:layout', JSON.stringify({ foldersCollapsed: { docs: true } }))
    const layout = new LayoutService()
    layout.setTreeVault('one')
    expect(layout.isFolderCollapsed('docs')).toBe(true)
    layout.expandFolders(['docs', 'docs/guide'])
    layout.setTreeVault('two')
    expect(layout.isFolderCollapsed('docs')).toBe(true)
    layout.expandFolders(['other'])
    layout.setTreeVault('one')
    expect(layout.isFolderCollapsed('docs/guide')).toBe(false)
    expect(layout.isFolderCollapsed('other')).toBe(true)
    const reopened = new LayoutService()
    reopened.setTreeVault('two')
    expect(reopened.isFolderCollapsed('other')).toBe(false)
    expect(reopened.isFolderCollapsed('docs')).toBe(true)
  })

  it('retains descendant state on parent collapse, but clears every level on collapse all', () => {
    const layout = new LayoutService()
    layout.setTreeVault('one')
    layout.expandFolders(['docs', 'docs/guide'])
    layout.setFolderCollapsed('docs', true)
    layout.setFolderCollapsed('docs', false)
    expect(layout.isFolderCollapsed('docs/guide')).toBe(false)
    layout.collapseAllFolders()
    layout.setFolderCollapsed('docs', false)
    expect(layout.isFolderCollapsed('docs/guide')).toBe(true)
  })

  it('migrates renamed descendants and drops deleted subtree state without touching siblings', () => {
    const layout = new LayoutService()
    layout.setTreeVault('one')
    layout.expandFolders(['docs', 'docs/guide', 'docs-other'])
    layout.showInTree(['docs', 'docs/guide'], { noteId: 'docs/guide/note' })
    layout.remapFolder('docs', 'work')
    expect(layout.isFolderCollapsed('work/guide')).toBe(false)
    expect(layout.isFolderCollapsed('docs')).toBe(true)
    expect(layout.revealedNoteId).toBe('work/guide/note')
    layout.forgetFolder('work')
    expect(layout.revealedNoteId).toBe('')
    expect(readFolderTreeState(localStorage, 'one')).toEqual({ 'docs-other': true })
  })

  it('navigation reveals only the necessary path and respects hidden panels', () => {
    const layout = new LayoutService()
    layout.setTreeVault('one')
    layout.expandFolders(['other'])
    layout.showInTree(['docs', 'docs/guide'], { noteId: 'docs/guide/note' }, false)
    expect(layout.foldersExpanded).toEqual({ other: true, docs: true, 'docs/guide': true })
    layout.collapseAllFolders()
    layout.setSidebarCollapsed(true)
    layout.showInTree(['docs'], { noteId: 'docs/note' }, false)
    expect(layout.sidebarCollapsed).toBe(true)
    expect(layout.isFolderCollapsed('docs')).toBe(true)
    layout.setSidebarCollapsed(false)
    layout.setRailSectionCollapsed('notes', true)
    layout.showInTree(['docs'], { noteId: 'docs/note' }, false)
    expect(layout.railCollapsed.notes).toBe(true)
    layout.showInTree(['docs'], { noteId: 'docs/note' })
    expect(layout.railCollapsed.notes).toBe(false)
    expect(layout.isFolderCollapsed('docs')).toBe(false)
  })

  it('handles malformed or unavailable storage and never stores an unbound tree', () => {
    localStorage.setItem(FOLDER_TREE_STORAGE_PREFIX + 'one', '{bad')
    expect(readFolderTreeState(localStorage, 'one')).toEqual({})
    localStorage.setItem(FOLDER_TREE_STORAGE_PREFIX + 'one', '["docs", 4, null, "", "__proto__"]')
    expect(Object.keys(readFolderTreeState(localStorage, 'one'))).toEqual(['docs', '__proto__'])
    const throwing = { getItem() { throw new Error() }, setItem() { throw new Error() } }
    expect(readFolderTreeState(throwing, 'one')).toEqual({})
    expect(() => writeFolderTreeState(throwing, 'one', { docs: true })).not.toThrow()
    writeFolderTreeState(localStorage, '', { docs: true })
    expect(localStorage.getItem(FOLDER_TREE_STORAGE_PREFIX)).toBeNull()
  })
})
