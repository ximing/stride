import { has, register, resolve } from '@rabjs/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { serializeView, VIEWS_ORDER_PATH } from '../../../../../packages/core/src/views'
import { NoteListService } from '../notes/note-list.service'
import { VaultService } from '../vault/vault.service'
import { buildViewFromDraft, ViewsService, type ViewDraft } from './views.service'

function useMemoryFixture() {
  window.history.replaceState(null, '', '/?fixture=memory')
}

function draft(partial: Partial<ViewDraft>): ViewDraft {
  return {
    file: '',
    name: '',
    icon: '',
    type: '',
    sortKey: '',
    sortDir: 'desc',
    archived: false,
    filters: [],
    ...partial,
  }
}

async function tick() {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 0))
}

async function openVault(): Promise<{ vault: VaultService; views: ViewsService }> {
  useMemoryFixture()
  vi.stubGlobal('showDirectoryPicker', vi.fn())
  register(VaultService)
  const views = resolve(ViewsService)
  const vault = resolve(VaultService)
  vault.cancelPending()
  await vault.createNewVault()
  return { vault, views }
}

describe('buildViewFromDraft', () => {
  it('drops blank rows and empty optionals, and requires a name', () => {
    expect(buildViewFromDraft(draft({ name: '  ' }))).toBeNull()
    expect(
      buildViewFromDraft(
        draft({
          name: 'Reading',
          filters: [
            { key: '  ', op: 'eq', value: 'x' },
            { key: 'status', op: 'contains', value: '  ' },
            { key: 'due', op: 'exists', value: 'ignored' },
            { key: 'status', op: 'eq', value: 'reading' },
          ],
          sortKey: 'title',
          sortDir: 'asc',
          archived: true,
        }),
      ),
    ).toEqual({
      version: 1,
      name: 'Reading',
      propertyFilters: [
        { key: 'due', op: 'exists' },
        { key: 'status', op: 'eq', value: 'reading' },
      ],
      sort: { key: 'title', dir: 'asc' },
      archived: true,
    })
  })
})

describe('ViewsService', () => {
  afterEach(() => {
    localStorage.clear()
    window.history.replaceState(null, '', '/')
    vi.unstubAllGlobals()
    try {
      const vault = resolve(VaultService)
      vault.cancelPending()
      vault.setFilter('all')
    } catch {
      // Not every case registers the vault.
    }
    try {
      resolve(ViewsService).draft = null
    } catch {
      // ViewsService self-registers on import; defensive only.
    }
  })

  it('creates a view file, lists it in sidebar order, and activation filters visibleNotes', async () => {
    const { vault, views } = await openVault()
    await vault.createNote()
    vault.updateType('Article')
    vault.updateProperty('status', 'reading')
    await vault.flush()
    const readingId = vault.activeId
    await vault.createNote()
    vault.updateType('Article')
    vault.updateProperty('status', 'done')
    await vault.flush()
    await vault.createNote()
    vault.updateProperty('status', 'reading')
    await vault.flush()

    views.draft = draft({
      name: 'Reading',
      type: 'Article',
      sortKey: 'title',
      sortDir: 'asc',
      filters: [{ key: 'status', op: 'eq', value: 'reading' }],
    })
    await views.saveDraft()

    expect(views.draft).toBeNull()
    expect(views.views.map((item) => item.file)).toEqual(['reading'])
    expect(views.views[0]?.view).toMatchObject({ name: 'Reading', type: 'Article', sort: { key: 'title', dir: 'asc' } })
    const onDisk = JSON.parse(await vault.fs!.readText('views/reading.json')) as { version: number; name: string }
    expect(onDisk).toMatchObject({ version: 1, name: 'Reading' })

    views.activate('reading')
    expect(vault.listFilter).toBe('view:reading')
    expect(views.activeView?.view.name).toBe('Reading')
    expect(vault.visibleNotes.map((note) => note.id)).toEqual([readingId])

    // Switching back to a builtin filter restores the builtin behavior.
    vault.setFilter('all')
    expect(views.activeView).toBeNull()
    expect(vault.visibleNotes.length).toBeGreaterThan(1)
  })

  it('renames a view, renames the file, keeps activation, and dedupes slugs', async () => {
    const { vault, views } = await openVault()
    views.draft = draft({ name: 'Reading' })
    await views.saveDraft()
    views.draft = draft({ name: 'Other' })
    await views.saveDraft()
    views.activate('reading')

    views.openEditor('reading')
    expect(views.draft?.name).toBe('Reading')
    views.updateDraft({ name: 'Other' })
    await views.saveDraft()
    // "Other" is taken, so the rename dedupes the file slug.
    expect(views.views.map((item) => item.file).sort()).toEqual(['other', 'other-2'])
    expect(vault.listFilter).toBe('view:other-2')
    expect(await vault.fs!.stat('views/reading.json')).toBeNull()
    const order = JSON.parse(await vault.fs!.readText(VIEWS_ORDER_PATH)) as { order: string[] }
    // A rename keeps the view's slot in the sidebar order.
    expect(order.order).toEqual(['other-2', 'other'])
  })

  it('deletes a view, drops it from the order file, and resets an active filter', async () => {
    const { vault, views } = await openVault()
    views.draft = draft({ name: 'Reading' })
    await views.saveDraft()
    views.activate('reading')
    expect(vault.listFilter).toBe('view:reading')

    await views.deleteView('reading')
    expect(views.views).toEqual([])
    expect(vault.listFilter).toBe('all')
    expect(await vault.fs!.stat('views/reading.json')).toBeNull()
    const order = JSON.parse(await vault.fs!.readText(VIEWS_ORDER_PATH)) as { order: string[] }
    expect(order.order).toEqual([])
  })

  it('reorders views via moveView and persists the order file', async () => {
    const { vault, views } = await openVault()
    for (const name of ['Alpha', 'Beta', 'Gamma']) {
      views.draft = draft({ name })
      await views.saveDraft()
    }
    expect(views.views.map((item) => item.file)).toEqual(['alpha', 'beta', 'gamma'])

    await views.moveView('gamma', 'alpha')
    expect(views.views.map((item) => item.file)).toEqual(['gamma', 'alpha', 'beta'])
    const order = JSON.parse(await vault.fs!.readText(VIEWS_ORDER_PATH)) as { order: string[] }
    expect(order.order).toEqual(['gamma', 'alpha', 'beta'])

    // No-op moves leave state and disk untouched.
    await views.moveView('gamma', 'gamma')
    expect(views.views.map((item) => item.file)).toEqual(['gamma', 'alpha', 'beta'])
  })

  it('captures the current type filter and list sort into a new draft', async () => {
    const { vault, views } = await openVault()
    vault.setFilter('Project')
    if (has(NoteListService)) resolve(NoteListService).sort = { key: 'title', dir: 'asc' }
    views.openNewEditor()
    expect(views.draft).toMatchObject({ file: '', name: 'Project', type: 'Project', sortKey: 'title', sortDir: 'asc' })
    views.closeEditor()

    vault.setFilter('inbox')
    views.openNewEditor()
    expect(views.draft).toMatchObject({ file: '', name: '', type: '' })
    views.closeEditor()
    expect(views.draft).toBeNull()
  })

  it('save-as-copy prefills the draft from the active view', async () => {
    const { vault, views } = await openVault()
    views.draft = draft({
      name: 'Reading',
      icon: '📚',
      type: 'Article',
      filters: [{ key: 'status', op: 'eq', value: 'reading' }],
    })
    await views.saveDraft()
    views.activate('reading')
    views.openNewEditor()
    expect(views.draft).toMatchObject({
      file: '',
      name: 'Reading copy',
      icon: '📚',
      type: 'Article',
      filters: [{ key: 'status', op: 'eq', value: 'reading' }],
    })
    expect(vault.listFilter).toBe('view:reading')
  })

  it('reloads when a view file appears externally (fs watch, e.g. git pull)', async () => {
    const { vault, views } = await openVault()
    expect(vault.fs!.capabilities.watch).toBe(true)
    expect(views.views).toEqual([])

    // Simulate git pull dropping a new view file + order update into the vault.
    await vault.fs!.writeText(
      'views/pulled.json',
      serializeView({ version: 1, name: 'Pulled', type: 'Article' }),
    )
    await tick()
    await tick()
    expect(views.views.map((item) => item.file)).toEqual(['pulled'])

    // External delete of the active view resets the list filter.
    views.activate('pulled')
    expect(vault.listFilter).toBe('view:pulled')
    await vault.fs!.remove('views/pulled.json')
    await tick()
    await tick()
    expect(views.views).toEqual([])
    expect(vault.listFilter).toBe('all')
  })

  it('keeps garbage view files out of the list without failing', async () => {
    const { vault, views } = await openVault()
    await vault.fs!.writeText('views/broken.json', '{not json')
    await vault.fs!.writeText('views/future.json', JSON.stringify({ version: 2, name: 'Future' }))
    await tick()
    await tick()
    expect(views.views).toEqual([])
    expect(vault.error).toBe('')
  })
})
