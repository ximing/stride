import { observer, register, resolve, useService } from '@rabjs/react'
import { relationsOf, buildGraph } from '@stride/core/graph'
import { plainText, type StrideNote, type TipTapNode } from '@stride/core/note'
import { MemoryFileSystem, PlatformError } from '@stride/platform'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { notePath, readNoteFile } from '../../../../packages/core/src/vault'
import { App, Rail } from '../app'
import { ChatService, GitService, SettingsService, UpdateService } from './panels.service'
import { FolderService } from './folder.service'
import { VAULT_REGISTRY_KEY, VaultService } from './vault.service'

function sample(id: string, title: string): StrideNote {
  return {
    id,
    title,
    type: 'note',
    properties: {},
    doc: { type: 'doc', content: [{ type: 'paragraph' }] },
  }
}

function useMemoryFixture() {
  window.history.replaceState(null, '', '/?fixture=memory')
}

function wikilinkTarget(doc: TipTapNode): string | undefined {
  let target: string | undefined
  const walk = (node: TipTapNode | undefined) => {
    if (!node || target) return
    if (node.type === 'wikilink' && typeof node.attrs?.target === 'string') target = node.attrs.target
    node.content?.forEach(walk)
  }
  walk(doc)
  return target
}

describe('VaultService', () => {
  afterEach(() => {
    window.history.replaceState(null, '', '/')
    localStorage.removeItem(VAULT_REGISTRY_KEY)
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('re-renders an observer when the service changes', async () => {
    register(VaultService)
    register(FolderService)
    const service = resolve(VaultService)
    const View = observer(function View() {
      const vault = useService(VaultService)
      return <output>{vault.pathDraft}</output>
    })
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => {
      root.render(<View />)
    })
    expect(host.textContent).toBe('')
    await act(async () => {
      service.setPathDraft('field-notes')
    })
    expect(host.textContent).toBe('field-notes')
    root.unmount()
    host.remove()
  })

  it('keeps a spaced title and does not rewrite a partial wikilink', () => {
    register(VaultService)
    register(FolderService)
    const vault = resolve(VaultService)
    const parent = sample('other-note', 'Other note')
    const child = sample('child', 'Child')
    vault.notes = [parent, child]
    vault.activeId = 'child'
    let shown = ''
    for (const ch of '[[Other note]]') {
      vault.updateProperty('belongs_to', shown + ch)
      shown = vault.propertyText('belongs_to')
    }
    expect(shown).toBe('[[Other note]]')
    vault.updateProperty('belongs_to', '[[')
    expect(vault.propertyText('belongs_to')).toBe('[[')
    vault.updateProperty('belongs_to', '[[Other note]]')
    const graph = buildGraph(vault.notes)
    expect(relationsOf(graph, 'child').shown.some((link) => link.targetId === 'other-note' && link.field === 'belongs_to')).toBe(true)
    expect(relationsOf(graph, 'other-note').shown.some((link) => link.field === 'has' && link.derived)).toBe(true)
    vault.cancelPending()
  })

  it('opens, creates, saves, and searches a memory vault', async () => {
    useMemoryFixture()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const picker = vi.fn()
    vi.stubGlobal('showDirectoryPicker', picker)
    register(VaultService)
    register(FolderService)
    register(GitService)
    const vault = resolve(VaultService)
    await vault.restoreOpened()
    expect(vault.phase).toBe('chooser')
    expect(picker).not.toHaveBeenCalled()

    await vault.openFromDraft()
    expect(picker).not.toHaveBeenCalled()
    expect(vault.phase).toBe('ready')
    expect(vault.vaultPath).toBe('memory-vault')
    expect(vault.error).toBe('')
    expect(vault.fs).toBeTruthy()

    await vault.createNote()
    expect(vault.active?.id).toMatch(/^untitled-[a-z0-9]{4}$/)
    expect(vault.active?.title).toBe('Untitled')
    const id = vault.active?.id ?? ''

    vault.updateTitle('Field notes')
    vault.updateDoc({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'zephyrword' }] }],
    })
    await vi.advanceTimersByTimeAsync(350)

    const saved = await readNoteFile(vault.fs!, `${id}.stride.json`, id)
    expect(saved.title).toBe('Field notes')
    expect(plainText(saved.doc)).toContain('zephyrword')
    expect(await vault.fs!.stat(`${id}.stride.json`)).not.toBeNull()
    expect(await vault.fs!.stat('field-notes.stride.json')).toBeNull()

    vault.searchQuery = 'zephyrword'
    await vault.runSearch()
    expect(vault.error).toBe('')
    expect(vault.searchMode).toBe('text')
    expect(vault.searchHits.some((hit) => hit.id === id)).toBe(true)
    expect(vault.visibleNotes.map((note) => note.id)).toEqual([id])

    vault.updateTitle('Flushed title')
    await resolve(GitService).commit()
    const flushed = await readNoteFile(vault.fs!, `${id}.stride.json`, id)
    expect(flushed.title).toBe('Flushed title')
    expect(resolve(GitService).output).toBe('Git is not available in the browser')
  })

  it('retries a failed autosave and keeps the in-memory note', async () => {
    useMemoryFixture()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const picker = vi.fn()
    vi.stubGlobal('showDirectoryPicker', picker)
    register(VaultService)
    register(FolderService)
    register(GitService)
    const vault = resolve(VaultService)
    await vault.restoreOpened()
    await vault.openFromDraft()
    await vault.createNote()
    const id = vault.active?.id ?? ''
    const writeText = vault.fs!.writeText.bind(vault.fs)
    let failed = false
    vault.fs!.writeText = async (path: string, data: string) => {
      if (!failed && path.endsWith('.stride.json')) {
        failed = true
        throw new Error('disk full')
      }
      return writeText(path, data)
    }

    vault.updateDoc({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'keep-me' }] }],
    })
    await vi.advanceTimersByTimeAsync(350)

    expect(vault.saveStatus).toBe('error')
    expect(plainText(vault.active!.doc)).toContain('keep-me')
    let onDisk = ''
    try {
      onDisk = plainText((await readNoteFile(vault.fs!, `${id}.stride.json`, id)).doc)
    } catch {
      onDisk = ''
    }
    expect(onDisk).not.toContain('keep-me')

    await vi.advanceTimersByTimeAsync(1000)

    expect(vault.saveStatus).toBe('saved')
    expect(vault.error).toBe('')
    const saved = await readNoteFile(vault.fs!, `${id}.stride.json`, id)
    expect(plainText(saved.doc)).toContain('keep-me')
    expect(plainText(vault.active!.doc)).toContain('keep-me')
    vault.cancelPending()
  })

  it('renames on commitHeadingRename and keeps the new id searchable', async () => {
    useMemoryFixture()
    register(VaultService)
    register(FolderService)
    const vault = resolve(VaultService)
    await vault.openFromDraft()
    await vault.createNote()
    const oldId = vault.active?.id ?? ''
    expect(oldId).toMatch(/^untitled-[a-z0-9]{4}$/)
    vault.updateTitle('Field notes')
    vault.updateDoc({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'zephyrword' }] }],
    })
    await vault.commitHeadingRename()
    expect(vault.error).toBe('')
    expect(vault.active?.id).toBe('field-notes')
    expect(await vault.fs!.stat(`${oldId}.stride.json`)).toBeNull()
    const saved = await readNoteFile(vault.fs!, 'field-notes.stride.json', 'field-notes')
    expect(saved.title).toBe('Field notes')
    expect(saved.doc.content?.[0]).toMatchObject({ type: 'heading', attrs: { level: 1 } })
    expect(plainText(saved.doc.content?.[0] ?? { type: 'doc' })).toBe('Field notes')

    await vault.createNote()
    const secondId = vault.active?.id ?? ''
    expect(secondId).toMatch(/^untitled-[a-z0-9]{4}$/)
    vault.updateDoc({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'secondquark' }] }],
    })
    await vault.flush()
    vault.searchQuery = 'zephyrword'
    await vault.runSearch()
    expect(vault.searchHits.some((hit) => hit.id === 'field-notes')).toBe(true)
    expect(vault.searchHits.some((hit) => hit.id === oldId)).toBe(false)
    vault.searchQuery = 'secondquark'
    await vault.runSearch()
    expect(vault.searchHits.some((hit) => hit.id === secondId)).toBe(true)
  })

  it('reindexes a note when it is moved into a folder', async () => {
    useMemoryFixture()
    register(VaultService)
    register(FolderService)
    const vault = resolve(VaultService)
    const folders = resolve(FolderService)
    await vault.openFromDraft()
    await vault.createNote()
    vault.updateTitle('Field notes')
    vault.updateDoc({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'movequark' }] }],
    })
    await vault.commitHeadingRename()
    expect(vault.active?.id).toBe('field-notes')
    await folders.createFolder('box')
    await folders.moveNote('field-notes', 'box')
    expect(vault.error).toBe('')
    expect(vault.active?.id).toBe('box/field-notes')
    vault.searchQuery = 'movequark'
    await vault.runSearch()
    expect(vault.searchHits.some((hit) => hit.id === 'box/field-notes')).toBe(true)
    expect(vault.searchHits.some((hit) => hit.id === 'field-notes')).toBe(false)
  })

  it('reindexes a note when its folder is renamed', async () => {
    useMemoryFixture()
    register(VaultService)
    register(FolderService)
    const vault = resolve(VaultService)
    const folders = resolve(FolderService)
    await vault.openFromDraft()
    await vault.createNote()
    vault.updateTitle('Field notes')
    vault.updateDoc({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'folderquark' }] }],
    })
    await vault.commitHeadingRename()
    await folders.createFolder('box')
    await folders.moveNote('field-notes', 'box')
    await folders.renameFolder('box', 'crate')
    expect(vault.error).toBe('')
    expect(vault.active?.id).toBe('crate/field-notes')
    vault.searchQuery = 'folderquark'
    await vault.runSearch()
    expect(vault.searchHits.some((hit) => hit.id === 'crate/field-notes')).toBe(true)
    expect(vault.searchHits.some((hit) => hit.id === 'box/field-notes')).toBe(false)
    expect(vault.searchHits.some((hit) => hit.id === 'field-notes')).toBe(false)
  })

  it('drops a deleted note from search', async () => {
    useMemoryFixture()
    register(VaultService)
    register(FolderService)
    const vault = resolve(VaultService)
    await vault.openFromDraft()
    await vault.createNote()
    const id = vault.active?.id ?? ''
    vault.updateDoc({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'deletequark' }] }],
    })
    await vault.flush()
    vault.searchQuery = 'deletequark'
    await vault.runSearch()
    expect(vault.searchHits.some((hit) => hit.id === id)).toBe(true)
    await vault.deleteActiveNote()
    await vault.runSearch()
    expect(vault.searchHits.some((hit) => hit.id === id)).toBe(false)
  })

  it('stays editable while a reopen rebuilds and keeps the live save searchable', async () => {
    useMemoryFixture()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    register(VaultService)
    register(FolderService)
    const vault = resolve(VaultService)
    await vault.openFromDraft()
    await vault.createNote()
    const id = vault.active?.id ?? ''
    vault.updateDoc({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'opencore' }] }],
    })
    await vault.flush()
    await vault.openFromDraft()
    expect(vault.phase).toBe('ready')
    expect(vault.indexPhase).toBe('rebuilding')
    expect(vault.indexDone).toBe(0)
    expect(vault.indexTotal).toBeGreaterThan(0)
    vault.activeId = id
    vault.updateTitle('Still editable')
    vault.updateDoc({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'livecore' }] }],
    })
    await vault.flush()
    vault.searchQuery = 'livecore'
    await vault.runSearch()
    expect(vault.searchHits.some((hit) => hit.id === id)).toBe(true)
    vault.searchQuery = 'opencore'
    await vault.runSearch()
    expect(vault.searchHits.some((hit) => hit.id === id)).toBe(false)
    await vi.runAllTimersAsync()
    expect(vault.indexPhase).toBe('ready')
    expect(vault.indexDone).toBe(vault.indexTotal)
    vault.searchQuery = 'livecore'
    await vault.runSearch()
    expect(vault.searchHits.some((hit) => hit.id === id)).toBe(true)
    vault.searchQuery = 'opencore'
    await vault.runSearch()
    expect(vault.searchHits.some((hit) => hit.id === id)).toBe(false)
  })

  it('leaves the untitled filename when renameFromHeading is false', async () => {
    useMemoryFixture()
    register(VaultService)
    register(FolderService)
    const vault = resolve(VaultService)
    await vault.openFromDraft()
    await vault.createNote()
    const id = vault.active?.id ?? ''
    await vault.setRenameFromHeading(false)
    vault.updateTitle('Field notes')
    await vault.commitHeadingRename()
    expect(vault.active?.id).toBe(id)
    expect(await vault.fs!.stat(`${id}.stride.json`)).not.toBeNull()
    expect(await vault.fs!.stat('field-notes.stride.json')).toBeNull()
    const saved = await readNoteFile(vault.fs!, `${id}.stride.json`, id)
    expect(saved.title).toBe('Field notes')
    expect(saved.doc.content?.[0]).toMatchObject({ type: 'heading', attrs: { level: 1 } })
    const marker = JSON.parse(await vault.fs!.readText('.stride/vault.json')) as {
      kind?: string
      version?: number
      renameFromHeading?: boolean
    }
    expect(marker.kind).toBe('stride-vault')
    expect(marker.version).toBe(1)
    expect(marker.renameFromHeading).toBe(false)
  })

  it('rewrites wikilinks when a real heading title changes', async () => {
    useMemoryFixture()
    register(VaultService)
    register(FolderService)
    const vault = resolve(VaultService)
    await vault.openFromDraft()
    await vault.createNote()
    vault.updateTitle('Old Title')
    await vault.commitHeadingRename()
    expect(vault.error).toBe('')
    expect(vault.active?.id).toBe('old-title')

    await vault.createNote()
    const linkerId = vault.active?.id ?? ''
    vault.updateDoc({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'wikilink', attrs: { target: 'Old Title' } }],
        },
      ],
    })
    vault.notes = vault.notes.map((note) =>
      note.id === linkerId ? { ...note, properties: { ...note.properties, related_to: '[[Old Title]]' } } : note,
    )
    await vault.flush()

    vault.activeId = 'old-title'
    vault.updateTitle('New Title')
    await vault.commitHeadingRename()
    expect(vault.error).toBe('')
    expect(vault.active?.id).toBe('new-title')
    const linked = vault.notes.find((note) => note.id === linkerId)
    expect(linked?.properties.related_to).toBe('[[New Title]]')
    expect(wikilinkTarget(linked?.doc ?? { type: 'doc' })).toBe('New Title')
  })

  it('does not rewrite wikilinks when renameFromHeading is false', async () => {
    useMemoryFixture()
    register(VaultService)
    register(FolderService)
    const vault = resolve(VaultService)
    await vault.openFromDraft()
    await vault.createNote()
    vault.updateTitle('Old Title')
    await vault.commitHeadingRename()
    expect(vault.active?.id).toBe('old-title')

    await vault.createNote()
    const linkerId = vault.active?.id ?? ''
    vault.updateDoc({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'wikilink', attrs: { target: 'Old Title' } }],
        },
      ],
    })
    vault.notes = vault.notes.map((note) =>
      note.id === linkerId ? { ...note, properties: { ...note.properties, related_to: '[[Old Title]]' } } : note,
    )
    await vault.flush()

    await vault.setRenameFromHeading(false)
    vault.activeId = 'old-title'
    vault.updateTitle('New Title')
    await vault.commitHeadingRename()
    expect(vault.error).toBe('')
    expect(vault.active?.id).toBe('old-title')
    const linked = vault.notes.find((note) => note.id === linkerId)
    expect(linked?.properties.related_to).toBe('[[Old Title]]')
    expect(wikilinkTarget(linked?.doc ?? { type: 'doc' })).toBe('Old Title')
  })

  it('rewrites wikilinks after autosave already stored the new title', async () => {
    useMemoryFixture()
    register(VaultService)
    register(FolderService)
    const vault = resolve(VaultService)
    await vault.openFromDraft()
    await vault.createNote()
    vault.updateTitle('Old Title')
    await vault.commitHeadingRename()
    expect(vault.error).toBe('')
    expect(vault.active?.id).toBe('old-title')

    await vault.createNote()
    const linkerId = vault.active?.id ?? ''
    vault.updateDoc({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'wikilink', attrs: { target: 'Old Title' } }],
        },
      ],
    })
    vault.notes = vault.notes.map((note) =>
      note.id === linkerId ? { ...note, properties: { ...note.properties, related_to: '[[Old Title]]' } } : note,
    )
    await vault.flush()

    vault.activeId = 'old-title'
    vault.updateTitle('New Title')
    await vault.flush()
    const stored = await readNoteFile(vault.fs!, 'old-title.stride.json', 'old-title')
    expect(stored.title).toBe('New Title')
    await vault.commitHeadingRename()
    expect(vault.error).toBe('')
    expect(vault.active?.id).toBe('new-title')
    const linked = vault.notes.find((note) => note.id === linkerId)
    expect(linked?.properties.related_to).toBe('[[New Title]]')
    expect(wikilinkTarget(linked?.doc ?? { type: 'doc' })).toBe('New Title')
  })

  it('keeps the title baseline across a folder move', async () => {
    useMemoryFixture()
    register(VaultService)
    register(FolderService)
    const vault = resolve(VaultService)
    await vault.openFromDraft()
    await vault.createNote()
    vault.updateTitle('Old Title')
    await vault.commitHeadingRename()
    expect(vault.error).toBe('')
    expect(vault.active?.id).toBe('old-title')

    await vault.createNote()
    const linkerId = vault.active?.id ?? ''
    vault.updateDoc({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'wikilink', attrs: { target: 'Old Title' } }],
        },
      ],
    })
    vault.notes = vault.notes.map((note) =>
      note.id === linkerId ? { ...note, properties: { ...note.properties, related_to: '[[Old Title]]' } } : note,
    )
    await vault.flush()

    vault.activeId = 'old-title'
    vault.updateTitle('New Title')
    await vault.flush()
    const folders = resolve(FolderService)
    await folders.createFolder('box')
    await folders.moveNote('old-title', 'box')
    await vault.commitHeadingRename()
    expect(vault.error).toBe('')
    expect(vault.active?.id).toBe('new-title')
    const linked = vault.notes.find((note) => note.id === linkerId)
    expect(linked?.properties.related_to).toBe('[[New Title]]')
    expect(wikilinkTarget(linked?.doc ?? { type: 'doc' })).toBe('New Title')
  })

  it('keeps a cancelled directory picker on the chooser', async () => {
    window.history.replaceState(null, '', '/')
    vi.stubGlobal('showDirectoryPicker', vi.fn(async () => {
      throw new PlatformError('io', 'The user aborted a request.')
    }))
    register(VaultService)
    register(FolderService)
    const vault = resolve(VaultService)
    await expect(vault.openFromDraft()).resolves.toBeUndefined()
    expect(vault.phase).toBe('chooser')
    expect(vault.error).toBe('The user aborted a request.')
  })

  it('shows search controls after the memory fixture opens', async () => {
    useMemoryFixture()
    const picker = vi.fn()
    vi.stubGlobal('showDirectoryPicker', picker)
    register(VaultService)
    register(FolderService)
    register(GitService)
    register(SettingsService)
    register(ChatService)
    register(UpdateService)
    const vault = resolve(VaultService)
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => {
      root.render(<App />)
    })
    expect(host.querySelector('[data-testid="open-vault"]')).not.toBeNull()
    expect(host.querySelector('[data-testid="vault-surface"]')).not.toBeNull()

    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="open-vault"]')!.click()
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 0))
    })
    expect(picker).not.toHaveBeenCalled()
    expect(vault.phase).toBe('ready')
    expect(host.querySelector('[data-testid="vault-search"]')).not.toBeNull()
    expect(host.querySelector('[data-testid="run-search"]')).not.toBeNull()
    expect(host.querySelector('[data-testid="new-note"]')).not.toBeNull()
    expect(host.querySelector('[data-testid="search-mode"]')).not.toBeNull()
    expect(host.querySelector('[data-testid="index-status"]')?.textContent).toBe('索引就绪')
    await act(async () => {
      vault.indexPhase = 'rebuilding'
      vault.indexDone = 2
      vault.indexTotal = 9
    })
    expect(host.querySelector('[data-testid="index-status"]')?.textContent).toBe('索引 2/9')
    await act(async () => {
      vault.indexPhase = 'error'
    })
    expect(host.querySelector('[data-testid="index-status"]')?.textContent).toBe('索引失败')
    await act(async () => {
      vault.indexPhase = 'ready'
    })
    expect(host.querySelector('[data-testid="index-status"]')?.textContent).toBe('索引就绪')
    root.unmount()
    host.remove()
  })

  it('upserts a vault id and refreshes lastOpened without duplicating it', () => {
    window.history.replaceState(null, '', '/')
    localStorage.removeItem(VAULT_REGISTRY_KEY)
    register(VaultService)
    register(FolderService)
    const vault = resolve(VaultService)
    vault.upsertVault({ id: 'v1', label: 'Notes', color: '', icon: '', lastOpened: '2026-01-01T00:00:00.000Z' })
    vault.upsertVault({
      id: 'v1',
      label: 'Notes renamed',
      color: '#b64024',
      icon: 'folder',
      lastOpened: '2026-02-01T00:00:00.000Z',
    })
    vault.upsertVault({ id: 'v2', label: 'Other', color: '', icon: '', lastOpened: '2026-03-01T00:00:00.000Z' })
    expect(vault.vaults.map((entry) => entry.id)).toEqual(['v1', 'v2'])
    expect(vault.vaults[0]).toEqual({
      id: 'v1',
      label: 'Notes renamed',
      color: '#b64024',
      icon: 'folder',
      lastOpened: '2026-02-01T00:00:00.000Z',
    })
    expect(JSON.parse(localStorage.getItem(VAULT_REGISTRY_KEY) ?? 'null')).toEqual(vault.vaults)
  })

  it('records two memory vaults and updates one entry when the same root opens again', async () => {
    useMemoryFixture()
    const picker = vi.fn()
    vi.stubGlobal('showDirectoryPicker', picker)
    register(VaultService)
    register(FolderService)
    const vault = resolve(VaultService)
    await vault.openFromDraft()
    const id = vault.activeVaultId
    const opened = vault.vaults[0]?.lastOpened ?? ''
    const root = vault.fs
    await vault.openFromDraft()
    expect(picker).not.toHaveBeenCalled()
    expect(vault.fs).toBe(root)
    expect(vault.vaults).toHaveLength(1)
    expect(vault.activeVaultId).toBe(id)
    expect(vault.vaults[0]?.lastOpened > opened).toBe(true)
    await vault.createNewVault()
    expect(vault.vaults).toHaveLength(2)
    expect(new Set(vault.vaults.map((entry) => entry.id)).size).toBe(2)
    expect(vault.vaults.every((entry) => entry.label === 'memory-vault')).toBe(true)
    expect(localStorage.getItem(VAULT_REGISTRY_KEY)).toBeNull()
    vault.cancelPending()
  })

  it('stays on the chooser when no vault is registered', async () => {
    window.history.replaceState(null, '', '/')
    localStorage.removeItem(VAULT_REGISTRY_KEY)
    const picker = vi.fn()
    vi.stubGlobal('showDirectoryPicker', picker)
    register(VaultService)
    register(FolderService)
    const vault = resolve(VaultService)
    await vault.restoreOpened()
    expect(vault.phase).toBe('chooser')
    expect(picker).not.toHaveBeenCalled()
  })

  it('keeps the current vault when a stored handle is missing', async () => {
    window.history.replaceState(null, '', '/')
    localStorage.removeItem(VAULT_REGISTRY_KEY)
    const picker = vi.fn()
    vi.stubGlobal('showDirectoryPicker', picker)
    Reflect.deleteProperty(globalThis, 'indexedDB')
    register(VaultService)
    register(FolderService)
    const vault = resolve(VaultService)
    const current = new MemoryFileSystem('current')
    vault.fs = current
    vault.phase = 'ready'
    vault.vaultPath = 'stay-put'
    vault.activeId = 'keep-me'
    vault.upsertVault({ id: 'current', label: 'Current', color: '', icon: '', lastOpened: '2026-01-01T00:00:00.000Z' })
    vault.upsertVault({ id: 'missing', label: 'Missing', color: '', icon: '', lastOpened: '2026-01-02T00:00:00.000Z' })
    vault.activeVaultId = 'current'
    await vault.switchVault('missing')
    expect(picker).not.toHaveBeenCalled()
    expect(vault.phase).toBe('ready')
    expect(vault.activeVaultId).toBe('current')
    expect(vault.vaultPath).toBe('stay-put')
    expect(vault.activeId).toBe('keep-me')
    expect(vault.fs?.rootLabel).toBe('current')
    expect(vault.error).toBe('The directory handle for this vault is missing.')
    expect(vault.vaults).toHaveLength(2)
  })

  it('lists recorded memory vaults in the header switcher', async () => {
    useMemoryFixture()
    const picker = vi.fn()
    vi.stubGlobal('showDirectoryPicker', picker)
    register(VaultService)
    register(FolderService)
    register(GitService)
    register(SettingsService)
    register(ChatService)
    register(UpdateService)
    const vault = resolve(VaultService)
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => {
      root.render(<App />)
    })
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="open-vault"]')!.click()
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 0))
    })
    await act(async () => {
      await vault.createNewVault()
    })
    expect(vault.vaults).toHaveLength(2)
    expect(host.querySelector('[data-testid="vault-switcher"]')?.textContent).toBe('memory-vault')
    expect(host.querySelector('[data-testid="type-link"]')).not.toBeNull()

    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="vault-switcher"]')!.click()
    })
    const options = [...host.querySelectorAll<HTMLButtonElement>('[data-testid="vault-option"]')]
    expect(options.map((node) => node.dataset.vaultId)).toEqual(vault.vaults.map((entry) => entry.id))
    const firstId = vault.vaults[0]?.id ?? ''
    await act(async () => {
      host.querySelector<HTMLButtonElement>(`[data-vault-id="${firstId}"]`)!.click()
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 0))
    })
    expect(picker).not.toHaveBeenCalled()
    expect(vault.activeVaultId).toBe(firstId)
    expect(vault.vaults).toHaveLength(2)
    expect(host.querySelector('[data-testid="type-link"]')).toBeNull()
    expect(host.querySelector('[data-testid="vault-switcher"]')?.textContent).toBe('memory-vault')
    root.unmount()
    host.remove()
    vault.cancelPending()
  })

  it('advances to the next inbox note after an outgoing property link', async () => {
    useMemoryFixture()
    register(VaultService)
    register(FolderService)
    const vault = resolve(VaultService)
    await vault.openFromDraft()
    await vault.setRenameFromHeading(true)
    expect(vault.advanceInbox).toBe(true)

    const first = sample('first', 'First')
    const second = sample('second', 'Second')
    vault.notes = [first, second]
    vault.setFilter('inbox')
    vault.activeId = 'first'
    expect(vault.graph.inbox.map((note) => note.id)).toEqual(['first', 'second'])

    vault.updateProperty('related_to', '[[Second]]')
    vault.cancelPending()
    expect(vault.activeId).toBe('second')
    expect(vault.graph.inbox.map((note) => note.id)).toEqual(['second'])

    await vault.setAdvanceInbox(false)
    const againFirst = sample('again-first', 'Again first')
    const againSecond = sample('again-second', 'Again second')
    vault.notes = [againFirst, againSecond]
    vault.activeId = 'again-first'
    vault.updateProperty('related_to', '[[Again second]]')
    vault.cancelPending()
    expect(vault.activeId).toBe('again-first')
    expect(vault.graph.inbox.map((note) => note.id)).toEqual(['again-second'])

    const marker = JSON.parse(await vault.fs!.readText('.stride/vault.json')) as {
      kind?: string
      version?: number
      renameFromHeading?: boolean
      advanceInbox?: boolean
    }
    expect(marker.kind).toBe('stride-vault')
    expect(marker.version).toBe(1)
    expect(marker.renameFromHeading).toBe(true)
    expect(marker.advanceInbox).toBe(false)

    await vault.openFromDraft()
    expect(vault.advanceInbox).toBe(false)
    expect(vault.renameFromHeading).toBe(true)
    await vault.setAdvanceInbox(true)
    vault.notes = [sample('alpha', 'Alpha'), sample('beta', 'Beta')]
    vault.setFilter('inbox')
    vault.activeId = 'alpha'
    vault.updateListProperty('related_to', '[[Beta]]')
    vault.cancelPending()
    expect(vault.activeId).toBe('beta')
    vault.setFilter('all')
  })

  it('does not leave the inbox or advance when only the type or body changes', async () => {
    useMemoryFixture()
    register(VaultService)
    register(FolderService)
    const vault = resolve(VaultService)
    await vault.openFromDraft()
    vault.notes = [sample('loose', 'Loose'), sample('other', 'Other')]
    vault.setFilter('inbox')
    vault.activeId = 'loose'
    vault.advanceInbox = true

    vault.updateType('project')
    vault.cancelPending()
    expect(vault.activeId).toBe('loose')
    expect(vault.graph.inbox.map((note) => note.id)).toEqual(['loose', 'other'])

    vault.updateDoc({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'see [[Other]]' }] }],
    })
    vault.cancelPending()
    expect(vault.activeId).toBe('loose')
    expect(vault.graph.inbox.map((note) => note.id)).toEqual(['loose', 'other'])
    vault.setFilter('all')
  })

  it('clears the selection instead of opening a type document', async () => {
    useMemoryFixture()
    register(VaultService)
    register(FolderService)
    const vault = resolve(VaultService)
    await vault.openFromDraft()
    const typeDoc: StrideNote = { ...sample('project-type', 'Project'), type: 'Type' }
    vault.notes = [sample('loose', 'Loose'), typeDoc]
    vault.setFilter('inbox')
    vault.activeId = 'loose'
    vault.advanceInbox = true
    vault.updateProperty('related_to', '[[Project]]')
    vault.cancelPending()
    expect(vault.activeId).toBe('')
    expect(vault.graph.inbox.map((note) => note.id)).toEqual(['project-type'])
    vault.setFilter('all')
  })

  it('shows the advance checkbox only while the inbox filter is selected', async () => {
    register(VaultService)
    register(FolderService)
    const vault = resolve(VaultService)
    vault.setFilter('all')
    vault.advanceInbox = true
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => {
      root.render(<Rail />)
    })
    expect(host.querySelector('[data-testid="advance-inbox"]')).toBeNull()
    await act(async () => {
      vault.setFilter('inbox')
    })
    const box = host.querySelector<HTMLInputElement>('[data-testid="advance-inbox"]')
    expect(box).not.toBeNull()
    expect(box?.checked).toBe(true)
    expect(host.textContent).toContain('Advance after organizing')
    await act(async () => {
      box?.click()
    })
    expect(vault.advanceInbox).toBe(false)
    await act(async () => {
      vault.setFilter('all')
    })
    expect(host.querySelector('[data-testid="advance-inbox"]')).toBeNull()
    root.unmount()
    host.remove()
    vault.advanceInbox = true
  })

  it('hides an archived note from visible lists without clearing the selection', async () => {
    useMemoryFixture()
    register(VaultService)
    const vault = resolve(VaultService)
    await vault.openFromDraft()
    await vault.createNote()
    const firstId = vault.active?.id ?? ''
    await vault.createNote()
    const currentId = vault.active?.id ?? ''
    expect(vault.visibleNotes.map((note) => note.id)).toEqual([currentId, firstId])
    expect(vault.inboxCount).toBe(2)

    vault.updateBooleanProperty('archived', true)
    expect(vault.visibleNotes.map((note) => note.id)).not.toContain(currentId)
    expect(vault.visibleNotes.map((note) => note.id)).toEqual([firstId])
    expect(vault.inboxCount).toBe(1)
    expect(vault.activeId).toBe(currentId)

    vault.updateBooleanProperty('archived', false)
    expect(vault.visibleNotes.map((note) => note.id)).toContain(currentId)
    expect(vault.visibleNotes.map((note) => note.id)).toEqual([currentId, firstId])
    expect(vault.inboxCount).toBe(2)
    vault.cancelPending()
  })

  it('deletes the active note file and drops it from the vault', async () => {
    useMemoryFixture()
    register(VaultService)
    const vault = resolve(VaultService)
    await vault.openFromDraft()
    await vault.createNote()
    const keptId = vault.active?.id ?? ''
    await vault.createNote()
    const id = vault.active?.id ?? ''
    expect(await vault.fs!.stat(notePath(id))).not.toBeNull()

    await vault.deleteActiveNote()
    expect(await vault.fs!.stat(notePath(id))).toBeNull()
    expect(vault.notes.some((note) => note.id === id)).toBe(false)
    expect(vault.notes.some((note) => note.id === keptId)).toBe(true)
    vault.cancelPending()
  })
})
