import { observer, register, resolve, useService } from '@rabjs/react'
import { relationsOf, buildGraph } from '@stride/core/graph'
import { plainText, type StrideNote } from '@stride/core/note'
import { PlatformError } from '@stride/platform'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readNoteFile } from '../../../../packages/core/src/vault'
import { App } from '../app'
import { ChatService, GitService, SettingsService, UpdateService } from './panels.service'
import { VaultService } from './vault.service'

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

describe('VaultService', () => {
  afterEach(() => {
    window.history.replaceState(null, '', '/')
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('re-renders an observer when the service changes', async () => {
    register(VaultService)
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

  it('renames on commitHeadingRename and keeps the new id searchable', async () => {
    useMemoryFixture()
    register(VaultService)
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

  it('leaves the untitled filename when renameFromHeading is false', async () => {
    useMemoryFixture()
    register(VaultService)
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

  it('keeps a cancelled directory picker on the chooser', async () => {
    window.history.replaceState(null, '', '/')
    vi.stubGlobal('showDirectoryPicker', vi.fn(async () => {
      throw new PlatformError('io', 'The user aborted a request.')
    }))
    register(VaultService)
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
    root.unmount()
    host.remove()
  })
})
