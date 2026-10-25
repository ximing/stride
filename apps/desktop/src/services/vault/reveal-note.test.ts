import { resolve } from '@rabjs/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LayoutService } from '../layout/layout.service'
import { folderChain, folderNotesToShow, parentFolder, showFolder, showNoteInFolder } from './reveal-note'

describe('parentFolder / folderChain', () => {
  it('splits a note id into its folder chain', () => {
    expect(parentFolder('box/inner/note')).toBe('box/inner')
    expect(parentFolder('note')).toBe('')
    expect(folderChain('box/inner')).toEqual(['box', 'box/inner'])
    expect(folderChain('')).toEqual([])
  })
})

describe('folderNotesToShow', () => {
  const notes = ['a', 'b', 'c', 'd'].map((id) => ({ id: `box/${id}` }))

  it('returns every note under the cap', () => {
    expect(folderNotesToShow(notes, 'box', 4, '').shown.map((note) => note.id)).toEqual([
      'box/a',
      'box/b',
      'box/c',
      'box/d',
    ])
    expect(folderNotesToShow(notes, 'box', 4, 'box/d').hidden).toBe(0)
  })

  it('keeps the cap and swaps in a note past it', () => {
    const visible = folderNotesToShow(notes, 'box', 2, 'box/d')
    expect(visible.shown.map((note) => note.id)).toEqual(['box/a', 'box/d'])
    expect(visible.hidden).toBe(2)
  })

  it('ignores a reveal that belongs to another folder', () => {
    const visible = folderNotesToShow(notes, 'box', 2, 'other/d')
    expect(visible.shown.map((note) => note.id)).toEqual(['box/a', 'box/b'])
    expect(visible.hidden).toBe(2)
  })
})

describe('showNoteInFolder', () => {
  beforeEach(() => {
    const layout = resolve(LayoutService)
    layout.setSidebarCollapsed(false)
    layout.setRailSectionCollapsed('notes', false)
    layout.foldersCollapsed = {}
    layout.revealedNoteId = ''
    layout.revealedFolderPath = ''
    layout.revealSeq = 0
  })

  it('scopes a nested note and expands its folders', () => {
    const layout = resolve(LayoutService)
    layout.setSidebarCollapsed(true)
    layout.setRailSectionCollapsed('notes', true)
    layout.setFolderCollapsed('box', true)
    layout.setFolderCollapsed('box/inner', true)
    const vault = { clearSearch: vi.fn(), setFilter: vi.fn() }
    showNoteInFolder(vault, 'box/inner/note')
    expect(vault.clearSearch).toHaveBeenCalledTimes(1)
    expect(vault.setFilter).toHaveBeenCalledWith('folder:box/inner')
    expect(layout.sidebarCollapsed).toBe(false)
    expect(layout.railCollapsed.notes).toBe(false)
    expect(layout.isFolderCollapsed('box')).toBe(false)
    expect(layout.isFolderCollapsed('box/inner')).toBe(false)
    expect(layout.revealedNoteId).toBe('box/inner/note')
    expect(layout.revealedFolderPath).toBe('')
  })

  it('leaves the list filter alone for a root note', () => {
    const vault = { clearSearch: vi.fn(), setFilter: vi.fn() }
    showNoteInFolder(vault, 'root-note')
    expect(vault.setFilter).not.toHaveBeenCalled()
    expect(resolve(LayoutService).revealedNoteId).toBe('root-note')
  })

  it('scopes the list to the folder row that was clicked', () => {
    const layout = resolve(LayoutService)
    layout.setFolderCollapsed('box', true)
    const vault = { clearSearch: vi.fn(), setFilter: vi.fn() }
    showFolder(vault, 'box')
    expect(vault.setFilter).toHaveBeenCalledWith('folder:box')
    expect(layout.isFolderCollapsed('box')).toBe(false)
    expect(layout.revealedFolderPath).toBe('box')
    expect(layout.revealedNoteId).toBe('')
  })
})
