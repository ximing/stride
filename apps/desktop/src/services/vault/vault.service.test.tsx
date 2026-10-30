import { has, observer, register, resolve, useService } from '@rabjs/react'
import { relationsOf, buildGraph, resolveNote } from '@stride/core/graph'
import { plainText, type StrideNote, type TipTapNode } from '@stride/core/note'
import { MemoryFileSystem, MemorySecretsStore } from '@stride/platform'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type NoteIndex, type SearchQuery } from '@stride/core'
import { notePath, readNoteFile } from '../../../../../packages/core/src/vault'
import { App, Rail } from '../../app'
import { ChatService } from '../chat/chat.service'
import { GitService } from '../git/git.service'
import { resetSecretsStore, setSecretsStore, SETTINGS_STORAGE_KEY, SettingsService } from '../settings/settings.service'
import { UpdateService } from '../update/update.service'
import { NoteListService } from '../notes/note-list.service'
import { FolderService } from './folder.service'
import { ListFilterService } from '../search/list-filter.service'
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
    localStorage.removeItem(SETTINGS_STORAGE_KEY)
    vi.useRealTimers()
    vi.unstubAllGlobals()
    resolve(ListFilterService).clear()
    resetSecretsStore()
    if (has(SettingsService)) {
      const settings = resolve(SettingsService)
      settings.form = {
        embedding: { endpoint: '', model: '', keyMask: '', dim: 4 },
        llmConfigs: [],
        releasesUrl: '',
        gitEnabled: true,
        autoSyncMinutes: 0,
        autoGitEnabled: false,
        autoGitIdleSeconds: 0,
        autoGitBlurSeconds: 0,
        appearance: { noteWidth: 'standard', fontSize: 15, fontFamily: '' },
        editor: { autosaveDebounceMs: 350 },
        updates: { channel: 'stable', autoCheck: true },
        privacy: { telemetryEnabled: false },
      }
      settings.setEmbeddingDim('4')
      settings.embeddingKey = ''
      settings.llmKeyDrafts = {}
      settings.selectedLlmId = ''
      settings.notice = ''
      settings.embeddingTestResult = ''
      settings.llmTestResult = ''
      Object.assign(settings, {
        memoryEmbeddingKey: '',
        memoryLlmKeys: {},
        loaded: false,
        loadTask: null,
      })
    }
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

    await (vault as unknown as { saveTask: Promise<void> }).saveTask
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
    await (vault as unknown as { saveTask: Promise<void> }).saveTask

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
    await (vault as unknown as { saveTask: Promise<void> }).saveTask

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

  it('remaps the list selection and search hits when a folder is renamed', async () => {
    useMemoryFixture()
    register(VaultService)
    register(FolderService)
    if (!has(NoteListService)) register(NoteListService)
    const vault = resolve(VaultService)
    const folders = resolve(FolderService)
    const list = resolve(NoteListService)
    await vault.openFromDraft()
    await vault.createNote()
    const rootId = vault.activeId
    await vault.createNote()
    vault.updateTitle('Field notes')
    await vault.commitHeadingRename()
    await folders.createFolder('box')
    await folders.moveNote(vault.activeId, 'box')
    const movedId = vault.activeId
    expect(movedId).toBe('box/field-notes')
    vault.activeId = rootId
    list.selectedIds = [movedId, rootId]
    list.anchorId = movedId
    vault.searchHits = [{ id: movedId, score: 3 }, { id: rootId, score: 1 }]

    await folders.renameFolder('box', 'crate')

    expect(vault.error).toBe('')
    expect(vault.activeId).toBe(rootId)
    expect(vault.notes.some((note) => note.id === 'crate/field-notes')).toBe(true)
    expect(vault.searchHits.map((hit) => hit.id)).toEqual(['crate/field-notes', rootId])
    expect(list.selectedIds).toEqual(['crate/field-notes', rootId])
    expect(list.anchorId).toBe('crate/field-notes')
  })

  it('leaves a folder note in place when the title does not change', async () => {
    useMemoryFixture()
    register(VaultService)
    register(FolderService)
    const vault = resolve(VaultService)
    const folders = resolve(FolderService)
    await vault.openFromDraft()
    await vault.createNote()
    vault.updateTitle('Field notes')
    await vault.commitHeadingRename()
    await folders.createFolder('box')
    await folders.moveNote('field-notes', 'box')
    expect(vault.active?.id).toBe('box/field-notes')

    await vault.commitHeadingRename()

    expect(vault.error).toBe('')
    expect(vault.active?.id).toBe('box/field-notes')
    expect(await vault.fs!.stat('box/field-notes.stride.json')).not.toBeNull()
    expect(await vault.fs!.stat('field-notes.stride.json')).toBeNull()
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

  it('keeps the previous title when a finished edit is blank or Untitled', async () => {
    useMemoryFixture()
    register(VaultService)
    register(FolderService)
    const vault = resolve(VaultService)
    await vault.openFromDraft()
    await vault.createNote()
    vault.updateTitle('Field notes')
    await vault.commitHeadingRename()
    const id = vault.active?.id ?? ''
    expect(id).toBe('field-notes')

    vault.updateDoc({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'kept-body' }] }],
    })
    await vault.commitTitleDraft(id, '')
    await vault.commitTitleDraft(id, '   ')
    await vault.commitTitleDraft(id, 'Untitled')

    expect(vault.error).toBe('')
    expect(vault.active?.id).toBe(id)
    expect(vault.active?.title).toBe('Field notes')
    const saved = await readNoteFile(vault.fs!, 'field-notes.stride.json', id)
    expect(saved.title).toBe('Field notes')
    expect(plainText(saved.doc)).toContain('kept-body')

    await vault.commitTitleDraft(id, '  Renamed page  ')
    expect(vault.active?.id).toBe('renamed-page')
    expect(vault.active?.title).toBe('Renamed page')
    expect(await vault.fs!.stat('field-notes.stride.json')).toBeNull()
    expect((await readNoteFile(vault.fs!, 'renamed-page.stride.json', 'renamed-page')).title).toBe('Renamed page')
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

  it('rewrites id links when the title stays and the slug id changes', async () => {
    useMemoryFixture()
    register(VaultService)
    register(FolderService)
    const vault = resolve(VaultService)
    await vault.openFromDraft()

    await vault.createNote()
    vault.updateTitle('Field notes')
    await vault.commitHeadingRename()
    expect(vault.active?.id).toBe('field-notes')
    const firstId = vault.activeId

    await vault.createNote()
    vault.updateTitle('Field notes')
    await vault.commitHeadingRename()
    expect(vault.active?.id).toBe('field-notes-2')
    const secondId = vault.activeId

    await vault.createNote()
    const linkerId = vault.active?.id ?? ''
    vault.updateDoc({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'wikilink', attrs: { target: secondId, alias: 'keep' } },
            { type: 'wikilink', attrs: { target: 'Field notes' } },
            { type: 'text', text: ` see [[${secondId}]] and [[Field notes]]` },
          ],
        },
      ],
    })
    vault.notes = vault.notes.map((note) =>
      note.id === linkerId
        ? { ...note, properties: { ...note.properties, related_to: `[[${secondId}]]`, also: '[[Field notes]]' } }
        : note,
    )
    await vault.flush()

    vault.activeId = secondId
    await vault.commitHeadingRename()
    expect(vault.error).toBe('')
    expect(vault.active?.id).toBe(secondId)
    const held = vault.notes.find((note) => note.id === linkerId)
    expect(held?.properties.related_to).toBe(`[[${secondId}]]`)
    expect(held?.properties.also).toBe('[[Field notes]]')

    await vault.deleteNotes([firstId])
    vault.activeId = secondId
    await vault.commitHeadingRename()

    expect(vault.error).toBe('')
    expect(vault.active?.id).toBe('field-notes')
    expect(await vault.fs!.stat('field-notes.stride.json')).not.toBeNull()
    expect(await vault.fs!.stat('field-notes-2.stride.json')).toBeNull()
    const linked = vault.notes.find((note) => note.id === linkerId)
    expect(linked?.properties.related_to).toBe('[[field-notes]]')
    expect(linked?.properties.also).toBe('[[Field notes]]')
    const links = linked?.doc.content?.[0]?.content ?? []
    expect(links.map((node) => (node.type === 'wikilink' ? node.attrs?.target : node.text))).toEqual([
      'field-notes',
      'Field notes',
      ' see [[field-notes]] and [[Field notes]]',
    ])
    expect(links[0]?.attrs?.alias).toBe('keep')
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
          content: [
            { type: 'wikilink', attrs: { target: 'Old Title', alias: 'keep' } },
            { type: 'wikilink', attrs: { target: 'box/old-title' } },
          ],
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
    expect(vault.active?.id).toBe('box/new-title')
    expect(await vault.fs!.stat('new-title.stride.json')).toBeNull()
    expect(await vault.fs!.stat('box/old-title.stride.json')).toBeNull()
    const saved = JSON.parse(await vault.fs!.readText('box/new-title.stride.json')) as {
      format?: string
      doc?: { type?: string }
    }
    expect(saved.format).toBe('tiptap')
    expect(saved.doc?.type).toBe('doc')
    const linkerFile = JSON.parse(await vault.fs!.readText(`${linkerId}.stride.json`)) as {
      format?: string
      doc?: { type?: string }
    }
    expect(linkerFile.format).toBe('tiptap')
    expect(linkerFile.doc?.type).toBe('doc')
    const linked = vault.notes.find((note) => note.id === linkerId)
    expect(linked?.properties.related_to).toBe('[[New Title]]')
    const links = linked?.doc.content?.[0]?.content ?? []
    expect(links.map((node) => node.attrs?.target)).toEqual(['New Title', 'New Title'])
    expect(links[0]?.attrs?.alias).toBe('keep')
    expect(resolveNote(vault.notes, 'New Title')?.id).toBe('box/new-title')
    expect(resolveNote(vault.notes, String(links[1]?.attrs?.target))?.id).toBe('box/new-title')
  })

  it('keeps a cancelled directory picker on the chooser', async () => {
    window.history.replaceState(null, '', '/')
    vi.stubGlobal('showDirectoryPicker', vi.fn(async () => {
      throw new DOMException('The user aborted a request.', 'AbortError')
    }))
    register(VaultService)
    register(FolderService)
    const vault = resolve(VaultService)
    await expect(vault.openFromDraft()).resolves.toBeUndefined()
    expect(vault.phase).toBe('chooser')
    expect(vault.error).toBe('')
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
    })
    await vi.waitFor(() => {
      expect(vault.phase, vault.error).toBe('ready')
    })
    expect(picker).not.toHaveBeenCalled()
    expect(host.querySelector('[data-testid="vault-search"]')).not.toBeNull()
    expect(host.querySelector('[data-testid="run-search"]')).toBeNull()
    expect(host.querySelector('.topbar')).toBeNull()
    expect(host.querySelector('[data-testid="new-note"]')).toBeNull()
    expect(host.querySelector('[data-testid="search-degraded"]')).toBeNull()
    await act(async () => {
      vault.searchDegraded = true
    })
    expect(host.querySelector('[data-testid="search-degraded"]')?.textContent).toBe('Fell back to BM25')
    await act(async () => {
      vault.searchDegraded = false
    })
    expect(host.querySelector('[data-testid="search-degraded"]')).toBeNull()
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="vault-search"]')!.click()
    })
    expect(host.querySelector('[data-testid="search-panel"]')).not.toBeNull()
    expect(host.querySelector('[data-testid="index-status"]')?.textContent).toBe('Index ready')
    await act(async () => {
      vault.indexPhase = 'rebuilding'
      vault.indexDone = 2
      vault.indexTotal = 9
    })
    expect(host.querySelector('[data-testid="index-status"]')?.textContent).toBe('Index 2/9')
    await act(async () => {
      vault.indexPhase = 'error'
    })
    expect(host.querySelector('[data-testid="index-status"]')?.textContent).toContain('Index failed')
    expect(host.querySelector('[data-testid="index-retry"]')).not.toBeNull()
    await act(async () => {
      vault.indexPhase = 'ready'
    })
    expect(host.querySelector('[data-testid="index-status"]')?.textContent).toBe('Index ready')
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

  it('merges a vault written by another window ahead of the local upsert', () => {
    window.history.replaceState(null, '', '/')
    localStorage.setItem(VAULT_REGISTRY_KEY, JSON.stringify([
      { id: 'remote', label: '/Users/remote', color: '', icon: '', lastOpened: '2026-01-01T00:00:00.000Z' },
    ]))
    register(VaultService)
    const vault = resolve(VaultService)
    vault.upsertVault({ id: 'local', label: '/Users/local', color: '', icon: '', lastOpened: '2026-02-01T00:00:00.000Z' })
    expect(vault.vaults.map((entry) => entry.id)).toEqual(['remote', 'local'])
  })

  it('keeps color and the open vault when the recent list is replaced', () => {
    window.history.replaceState(null, '', '/')
    localStorage.removeItem(VAULT_REGISTRY_KEY)
    register(VaultService)
    const vault = resolve(VaultService)
    vault.upsertVault({
      id: 'open',
      label: '/Users/notes',
      color: '#112233',
      icon: 'book',
      lastOpened: '2026-04-01T00:00:00.000Z',
    })
    vault.activeVaultId = 'open'
    vault.replaceRecentProjects([
      { id: 'other', path: '/Users/other', title: 'other', lastOpened: '2026-05-01T00:00:00.000Z' },
      { id: 'open', path: '/Users/notes', title: 'notes', lastOpened: '2026-03-01T00:00:00.000Z' },
    ])
    expect(vault.vaults.find((entry) => entry.id === 'open')).toMatchObject({
      color: '#112233',
      icon: 'book',
      lastOpened: '2026-04-01T00:00:00.000Z',
    })
    vault.replaceRecentProjects([
      { id: 'other', path: '/Users/other', title: 'other', lastOpened: '2026-05-01T00:00:00.000Z' },
    ])
    expect(vault.vaults.map((entry) => entry.id)).toEqual(['other', 'open'])
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

  it('clears the list filter when another vault opens', async () => {
    useMemoryFixture()
    register(VaultService)
    register(FolderService)
    const vault = resolve(VaultService)
    const listFilter = resolve(ListFilterService)
    await vault.openFromDraft()
    await vault.createNote()
    vault.updateTitle('Field notes')
    await vault.flush()
    listFilter.setQuery('zephyrhide')
    expect(vault.visibleNotes.some((note) => note.title === 'Field notes')).toBe(true)
    expect(listFilter.apply(vault.visibleNotes)).toEqual([])

    vault.updateDoc({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'keep-filter' }] }],
    })
    await vault.flush()
    vault.searchQuery = 'keep-filter'
    await vault.runSearch()
    expect(listFilter.query).toBe('zephyrhide')

    await vault.cloneSampleVault()
    expect(vault.error).toBe('')
    expect(listFilter.query).toBe('')
    expect(listFilter.apply(vault.visibleNotes).map((note) => note.title).sort()).toEqual([
      'Ada Lovelace',
      'Sample project',
      'Welcome',
    ])
    vault.cancelPending()
  })

  it('degrades to BM25 when the embedding key is removed or the request fails', async () => {
    useMemoryFixture()
    const picker = vi.fn()
    vi.stubGlobal('showDirectoryPicker', picker)
    const secrets = new MemorySecretsStore()
    setSecretsStore(secrets)
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { input?: string[] }
      const input = body.input ?? []
      return new Response(JSON.stringify({
        data: input.map((_text, index) => ({ index, embedding: [1, 0, 0, 0] })),
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fetchMock)
    register(VaultService)
    register(FolderService)
    register(SettingsService)
    const vault = resolve(VaultService)
    const settings = resolve(SettingsService)
    await vault.openFromDraft()
    await vault.createNote()
    const id = vault.active?.id ?? ''
    vault.updateTitle('Field notes')
    vault.updateDoc({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'zephyrword' }] }],
    })
    await vault.flush()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(vault.saveStatus).toBe('saved')

    settings.patchEmbedding({ endpoint: 'http://127.0.0.1/v1', model: 'fixture-embed' })
    settings.setEmbeddingDim('4')
    settings.embeddingKey = 'sk-stride-embed-test-key'
    await settings.save()
    for (let attempt = 0; attempt < 40 && vault.indexPhase === 'rebuilding'; attempt += 1) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 0))
    }
    expect(picker).not.toHaveBeenCalled()
    expect(vault.indexPhase).toBe('ready')
    expect(vault.searchDegraded).toBe(false)
    expect(fetchMock).toHaveBeenCalled()
    expect((vault as unknown as { index: NoteIndex }).index.dim).toBe(4)

    const index = (vault as unknown as { index: NoteIndex }).index
    const searches: SearchQuery[] = []
    const original = index.search.bind(index)
    index.search = async (query: SearchQuery) => {
      searches.push(query)
      return original(query)
    }
    fetchMock.mockClear()
    const ranked = await vault.queryRanked('zephyrword')
    expect(ranked[0]?.id).toBe(id)
    expect(ranked[0]?.source).toBe('body')
    expect(searches[0]).toMatchObject({ text: 'zephyrword', topK: 30, mode: 'hybrid', vector: [1, 0, 0, 0] })
    expect(vault.searchMode).toBe('hybrid')
    expect(vault.searchDegraded).toBe(false)

    fetchMock.mockImplementation(async () => new Response('no', { status: 503 }))
    // The previous query vector is cached. A different query still matches the note and misses the cache.
    vault.searchQuery = 'field'
    await vault.runSearch()
    expect(vault.error).toBe('')
    expect(vault.searchMode).toBe('text')
    expect(vault.searchDegraded).toBe(true)
    expect(vault.searchHits.some((hit) => hit.id === id)).toBe(true)

    fetchMock.mockClear()
    settings.embeddingKey = ''
    await settings.save()
    for (let attempt = 0; attempt < 40 && vault.indexPhase === 'rebuilding'; attempt += 1) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 0))
    }
    expect(picker).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(vault.indexPhase).toBe('ready')
    expect(vault.searchDegraded).toBe(true)
    expect((vault as unknown as { index: NoteIndex }).index.dim).toBe(0)
    vault.searchQuery = 'zephyrword'
    await vault.runSearch()
    expect(vault.searchMode).toBe('text')
    expect(vault.searchDegraded).toBe(true)
    expect(fetchMock).not.toHaveBeenCalled()
    expect((localStorage.getItem(SETTINGS_STORAGE_KEY) ?? '').includes('sk-stride-embed-test-key')).toBe(false)

    settings.embeddingKey = 'sk-stride-embed-test-key'
    fetchMock.mockImplementation(async () => new Response('no', { status: 500 }))
    await settings.save()
    for (let attempt = 0; attempt < 40 && vault.indexPhase === 'rebuilding'; attempt += 1) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 0))
    }
    expect(vault.indexPhase).toBe('ready')
    // The first successful embed is already in the disk cache, so this 500 does not open a document gap.
    expect(vault.searchDegraded).toBe(false)
    expect((vault as unknown as { index: NoteIndex }).index.dim).toBe(4)
    vault.searchQuery = 'zephyrword'
    await vault.runSearch()
    expect(vault.searchMode).toBe('text')
    expect(vault.searchHits.some((hit) => hit.id === id)).toBe(true)
    vault.cancelPending()
  })

  it('reopens the index when the saved embedding dim or model changes', async () => {
    useMemoryFixture()
    const picker = vi.fn()
    vi.stubGlobal('showDirectoryPicker', picker)
    setSecretsStore(new MemorySecretsStore())
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { input?: string[] }
      const input = body.input ?? []
      return new Response(JSON.stringify({
        data: input.map((_text, index) => ({ index, embedding: [1, 0, 0, 0] })),
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fetchMock)
    register(VaultService)
    register(FolderService)
    register(SettingsService)
    const vault = resolve(VaultService)
    const settings = resolve(SettingsService)
    await vault.openFromDraft()
    await vault.createNote()
    vault.updateTitle('Field notes')
    await vault.flush()
    const opened = (vault as unknown as { index: NoteIndex }).index
    expect(opened.dim).toBe(0)

    await settings.save()
    expect(picker).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
    expect((vault as unknown as { index: NoteIndex }).index).toBe(opened)

    settings.patchEmbedding({ endpoint: 'http://127.0.0.1/v1', model: 'fixture-embed' })
    settings.setEmbeddingDim('4')
    settings.embeddingKey = 'sk-stride-embed-test-key'
    await settings.save()
    for (let attempt = 0; attempt < 40 && vault.indexPhase === 'rebuilding'; attempt += 1) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 0))
    }
    expect(vault.indexPhase).toBe('ready')
    expect((vault as unknown as { index: NoteIndex }).index.dim).toBe(4)
    const afterDim4 = fetchMock.mock.calls.length
    expect(afterDim4).toBeGreaterThan(0)
    expect(picker).not.toHaveBeenCalled()

    settings.embeddingKey = settings.form.embedding.keyMask
    settings.setEmbeddingDim('8')
    await settings.save()
    for (let attempt = 0; attempt < 40 && vault.indexPhase === 'rebuilding'; attempt += 1) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 0))
    }
    expect(vault.indexPhase).toBe('ready')
    expect((vault as unknown as { index: NoteIndex }).index.dim).toBe(8)
    const afterDim8 = fetchMock.mock.calls.length
    expect(afterDim8).toBeGreaterThan(afterDim4)
    expect(picker).not.toHaveBeenCalled()

    settings.embeddingKey = settings.form.embedding.keyMask
    settings.patchEmbedding({ model: 'fixture-embed-2' })
    await settings.save()
    for (let attempt = 0; attempt < 40 && vault.indexPhase === 'rebuilding'; attempt += 1) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 0))
    }
    expect(vault.indexPhase).toBe('ready')
    expect((vault as unknown as { index: NoteIndex }).index.dim).toBe(8)
    expect(fetchMock.mock.calls.length).toBeGreaterThan(afterDim8)
    expect(picker).not.toHaveBeenCalled()
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

  it('shows an alias in the switcher and keeps the folder path', async () => {
    register(VaultService)
    const vault = resolve(VaultService)
    vault.upsertVault({
      id: 'notes',
      label: '/Users/ximing/notes',
      color: '',
      icon: '',
      lastOpened: '2026-01-01T00:00:00.000Z',
    })
    vault.activeVaultId = 'notes'
    expect(vault.currentVaultLabel).toBe('notes')
    vault.setVaultAlias('notes', '  我的笔记 ')
    expect(vault.currentVaultLabel).toBe('我的笔记')
    expect(vault.vaults.find((entry) => entry.id === 'notes')?.label).toBe('/Users/ximing/notes')
    const stored = JSON.parse(localStorage.getItem(VAULT_REGISTRY_KEY) ?? '[]') as Array<{ alias?: string }>
    expect(stored[0]?.alias).toBe('我的笔记')
    vault.setVaultAlias('notes', '   ')
    expect(vault.currentVaultLabel).toBe('notes')
  })

  it('lists recorded memory vaults in the status bar switcher', async () => {
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
    const options = [...document.querySelectorAll<HTMLButtonElement>('[data-testid="vault-option"]')]
    expect(options.map((node) => node.dataset.vaultId)).toEqual(vault.vaults.map((entry) => entry.id))
    const firstId = vault.vaults[0]?.id ?? ''
    await act(async () => {
      document.querySelector<HTMLButtonElement>(`[data-testid="vault-option"][data-vault-id="${firstId}"]`)!.click()
    })
    await vi.waitFor(() => {
      expect(vault.activeVaultId).toBe(firstId)
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

  it('opens the chooser from the vault switcher add action', async () => {
    useMemoryFixture()
    vi.stubGlobal('showDirectoryPicker', vi.fn())
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
    expect(vault.phase).toBe('ready')

    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="vault-switcher"]')!.click()
    })
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-testid="vault-add"]')!.click()
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 0))
    })
    expect(vault.phase).toBe('chooser')
    expect(host.querySelector('.chooser')).not.toBeNull()
    expect(host.querySelector('[data-testid="new-vault"]')).not.toBeNull()
    expect(host.querySelector('[data-testid="vault-switcher"]')).toBeNull()
    root.unmount()
    host.remove()
    vault.cancelPending()
  })

  it('lists previously opened vaults on the chooser, newest first', async () => {
    useMemoryFixture()
    register(VaultService)
    register(FolderService)
    register(GitService)
    register(SettingsService)
    register(ChatService)
    register(UpdateService)
    const vault = resolve(VaultService)
    vault.phase = 'chooser'
    vault.vaults = []
    vault.upsertVault({ id: 'older', label: '/Users/ximing/older-notes', color: '', icon: '', lastOpened: '2026-01-01T00:00:00.000Z' })
    vault.upsertVault({ id: 'newer', label: 'Field notes', color: '', icon: '', lastOpened: '2026-06-01T00:00:00.000Z' })
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => {
      root.render(<App />)
    })
    const rows = [...host.querySelectorAll<HTMLButtonElement>('[data-testid="recent-vault"]')]
    expect(rows.map((node) => node.dataset.vaultId)).toEqual(['newer', 'older'])
    expect(rows[0]?.textContent).toContain('Field notes')
    expect(rows[1]?.querySelector('.chooser-recent-label')?.textContent).toBe('older-notes')
    expect(rows[1]?.querySelector('.chooser-recent-path')?.textContent).toBe('/Users/ximing/older-notes')
    expect(host.querySelector('[data-testid="new-vault"]')).not.toBeNull()
    root.unmount()
    host.remove()
    vault.vaults = []
    vault.cancelPending()
  })

  it('reopens a recent vault from the chooser', async () => {
    useMemoryFixture()
    vi.stubGlobal('showDirectoryPicker', vi.fn())
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
      await vault.createNewVault()
    })
    const openedId = vault.activeVaultId
    expect(openedId).not.toBe('')
    await act(async () => {
      await vault.showChooser()
    })
    expect(host.querySelector('.chooser')).not.toBeNull()
    await act(async () => {
      host.querySelector<HTMLButtonElement>(`[data-testid="recent-vault"][data-vault-id="${openedId}"]`)!.click()
    })
    await vi.waitFor(() => {
      expect(vault.phase).toBe('ready')
    })
    expect(vault.phase).toBe('ready')
    expect(vault.activeVaultId).toBe(openedId)
    expect(host.querySelector('.chooser')).toBeNull()
    expect(host.querySelector('[data-testid="vault-switcher"]')).not.toBeNull()
    root.unmount()
    host.remove()
    vault.vaults = []
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

  it('toggles advance after organizing from the inbox context menu', async () => {
    register(VaultService)
    register(FolderService)
    const vault = resolve(VaultService)
    vault.setFilter('inbox')
    vault.advanceInbox = true
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => {
      root.render(<Rail />)
    })
    expect(host.querySelector('[data-testid="advance-inbox"]')).toBeNull()
    expect(host.textContent).not.toContain('Advance after organizing')
    const inbox = host.querySelector<HTMLButtonElement>('[data-testid="rail-inbox"]')
    expect(inbox).not.toBeNull()
    await act(async () => {
      inbox!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 16, clientY: 40 }))
    })
    const item = document.querySelector<HTMLElement>('[data-testid="context-menu-item-advance-inbox"]')
    expect(item).not.toBeNull()
    expect(item?.getAttribute('aria-checked')).toBe('true')
    expect(item?.textContent).toContain('Advance after organizing')
    await act(async () => {
      item!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    expect(vault.advanceInbox).toBe(false)
    expect(document.querySelector('[data-testid="context-menu"]')).toBeNull()
    root.unmount()
    host.remove()
    vault.advanceInbox = true
  })

  it('markProcessed flags _processed, persists it, and drops the note from the inbox', async () => {
    useMemoryFixture()
    vi.stubGlobal('showDirectoryPicker', vi.fn())
    register(VaultService)
    const vault = resolve(VaultService)
    await vault.openFromDraft()
    vault.notes = [sample('loose', 'Loose'), sample('other', 'Other')]
    expect(vault.graph.inbox.map((note) => note.id).sort()).toEqual(['loose', 'other'])

    vault.markProcessed('loose')
    expect(vault.notes.find((note) => note.id === 'loose')?.properties._processed).toBe(true)
    expect(vault.graph.inbox.map((note) => note.id)).toEqual(['other'])

    // Unknown ids are a no-op.
    vault.markProcessed('ghost')
    expect(vault.notes.map((note) => note.id).sort()).toEqual(['loose', 'other'])

    // The flag survives the debounced save round-trip to disk.
    await vault.flush()
    const disk = await readNoteFile(vault.fs!, notePath('loose'))
    expect(disk.properties._processed).toBe(true)
    vault.setFilter('all')
  })

  it('setTagColor writes vault.json and tagColorFor prefers the explicit color', async () => {
    useMemoryFixture()
    vi.stubGlobal('showDirectoryPicker', vi.fn())
    register(VaultService)
    const vault = resolve(VaultService)
    await vault.openFromDraft()

    // Default: deterministic hash, never gray.
    const hashed = vault.tagColorFor('alpha')
    expect(hashed).not.toBe('gray')
    expect(vault.tagColorFor('alpha')).toBe(hashed)

    await vault.setTagColor('alpha', 'pink')
    expect(vault.tagColorFor('alpha')).toBe('pink')
    const marker = JSON.parse(await vault.fs!.readText('.stride/vault.json')) as { tagColors?: Record<string, string> }
    expect(marker.tagColors).toEqual({ alpha: 'pink' })

    // Setting the same color again is a no-op; null/gray clears back to the hash.
    await vault.setTagColor('alpha', 'pink')
    await vault.setTagColor('alpha', null)
    expect(vault.tagColors).toEqual({})
    expect(vault.tagColorFor('alpha')).toBe(hashed)
    const cleared = JSON.parse(await vault.fs!.readText('.stride/vault.json')) as { tagColors?: Record<string, string> }
    expect(cleared.tagColors).toEqual({})
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
