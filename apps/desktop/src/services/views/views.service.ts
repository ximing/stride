import { has, register, Service } from '@rabjs/react'
import {
  applyViewsOrder,
  dedupeViewSlug,
  listViews,
  moveViewBefore,
  readViewsOrder,
  removeViewFile,
  VIEW_FILE_VERSION,
  VIEW_FILTER_PREFIX,
  VIEWS_DIR,
  VIEWS_ORDER_PATH,
  viewSlug,
  writeViewFile,
  writeViewsOrder,
  type LoadedView,
  type SavedView,
  type ViewFilterOp,
  type ViewSortDir,
  type ViewSortKey,
} from '@stride/core'
import { NoteListService } from '../notes/note-list.service'
import { VaultService } from '../vault/vault.service'

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export interface ViewFilterDraft {
  key: string
  op: ViewFilterOp
  value: string
}

/**
 * Editor draft for the view modal. `file === ''` means the view does not exist
 * yet (New view / Save current as view); otherwise it is the slug being edited.
 */
export interface ViewDraft {
  file: string
  name: string
  icon: string
  /** One of the nine type-color keys, or '' for no tint. */
  color: string
  type: string
  sortKey: '' | ViewSortKey
  sortDir: ViewSortDir
  archived: boolean
  filters: ViewFilterDraft[]
}

function draftFromView(file: string, view: SavedView): ViewDraft {
  return {
    file,
    name: view.name,
    icon: view.icon ?? '',
    color: view.color ?? '',
    type: view.type ?? '',
    sortKey: view.sort?.key ?? '',
    sortDir: view.sort?.dir ?? 'desc',
    archived: view.archived === true,
    filters: (view.propertyFilters ?? []).map((filter) => ({
      key: filter.key,
      op: filter.op,
      value: filter.value ?? '',
    })),
  }
}

/** Draft → SavedView. Returns null when the (required) name is blank. */
export function buildViewFromDraft(draft: ViewDraft): SavedView | null {
  const name = draft.name.trim()
  if (!name) return null
  const view: SavedView = { version: VIEW_FILE_VERSION, name }
  const icon = draft.icon.trim()
  if (icon) view.icon = icon
  const color = draft.color.trim()
  if (color) view.color = color
  const type = draft.type.trim()
  if (type) view.type = type
  const filters: SavedView['propertyFilters'] = []
  for (const filter of draft.filters) {
    const key = filter.key.trim()
    if (!key) continue
    if (filter.op === 'exists') filters.push({ key, op: 'exists' })
    else if (filter.value.trim() !== '') filters.push({ key, op: filter.op, value: filter.value })
  }
  if (filters.length > 0) view.propertyFilters = filters
  if (draft.sortKey !== '') view.sort = { key: draft.sortKey, dir: draft.sortDir }
  if (draft.archived) view.archived = true
  return view
}

/**
 * Saved Views (T6.6): loads `views/*.json` from the vault, owns the sidebar
 * order (`.stride/views-order.json`), the view editor draft, and drag reorder.
 *
 * - Activation is encoded in `VaultService.listFilter` as `view:<slug>`, so
 *   every existing "reset filter to all" path (new note, vault switch, …)
 *   automatically clears the active view. `VaultService.visibleNotes` resolves
 *   the view through this service.
 * - External changes (git pull): `onVaultOpened` re-scans after any vault
 *   reopen, and when the fs backend supports watching we subscribe to
 *   `views/` + the order file and reload. Writes made here bump `localWrites`
 *   so our own watch events (synchronous on MemoryFileSystem) are ignored.
 * - No reactions are used anywhere: the reload triggers are the explicit
 *   vault-open handover (same protocol as NoteListService) and watch events,
 *   so the queueMicrotask/untracked traps never come into play.
 */
export class ViewsService extends Service {
  views: LoadedView[] = []
  draft: ViewDraft | null = null
  private stopWatch: (() => void) | null = null
  private localWrites = 0

  private get vault(): VaultService | null {
    return has(VaultService) ? this.resolve(VaultService) : null
  }

  byFile(file: string): LoadedView | null {
    return this.views.find((item) => item.file === file) ?? null
  }

  /** The view the current listFilter activates, if any. */
  get activeView(): LoadedView | null {
    const vault = this.vault
    if (!vault) return null
    const filter = vault.listFilter
    if (!filter.startsWith(VIEW_FILTER_PREFIX)) return null
    return this.byFile(filter.slice(VIEW_FILTER_PREFIX.length))
  }

  isActive(file: string): boolean {
    return this.vault?.listFilter === `${VIEW_FILTER_PREFIX}${file}`
  }

  activate(file: string) {
    const vault = this.vault
    if (!vault || !this.byFile(file)) return
    vault.setFilter(`${VIEW_FILTER_PREFIX}${file}`)
  }

  /** VaultService calls this at the end of openBackendBody (fs is final). */
  async onVaultOpened() {
    this.teardownWatch()
    this.draft = null
    await this.reload()
    await this.attachWatch()
  }

  async reload() {
    const vault = this.vault
    const fs = vault?.fs
    if (!vault || !fs) {
      this.views = []
      return
    }
    try {
      const [loaded, order] = await Promise.all([listViews(fs), readViewsOrder(fs)])
      this.views = applyViewsOrder(loaded, order)
      // The active view vanished on disk (external delete): fall back to All.
      const filter = vault.listFilter
      if (filter.startsWith(VIEW_FILTER_PREFIX) && !this.byFile(filter.slice(VIEW_FILTER_PREFIX.length))) {
        vault.setFilter('all')
      }
      if (this.draft && this.draft.file !== '' && !this.byFile(this.draft.file)) this.draft = null
    } catch (error) {
      vault.error = errorText(error)
    }
  }

  /** New-view editor, prefilled from the current list state (type + sort). */
  openNewEditor() {
    const vault = this.vault
    const filter = vault?.listFilter ?? 'all'
    const active = this.activeView
    let draft: ViewDraft
    if (active) {
      // Save-as-copy of the active view.
      draft = { ...draftFromView('', active.view), name: `${active.view.name} copy` }
    } else {
      const capturesType = filter !== 'all' && filter !== 'inbox' && !filter.startsWith(VIEW_FILTER_PREFIX)
      const sort = has(NoteListService) ? this.resolve(NoteListService).sort : null
      draft = {
        file: '',
        name: capturesType ? filter : '',
        icon: '',
        color: '',
        type: capturesType ? filter : '',
        sortKey: sort?.key ?? '',
        sortDir: sort?.dir ?? 'desc',
        archived: false,
        filters: [],
      }
    }
    this.draft = draft
  }

  openEditor(file: string) {
    const loaded = this.byFile(file)
    if (!loaded) return
    this.draft = draftFromView(loaded.file, loaded.view)
  }

  closeEditor() {
    this.draft = null
  }

  updateDraft(patch: Partial<Omit<ViewDraft, 'file' | 'filters'>>) {
    if (!this.draft) return
    this.draft = { ...this.draft, ...patch }
  }

  addDraftFilter() {
    if (!this.draft) return
    this.draft = { ...this.draft, filters: [...this.draft.filters, { key: '', op: 'contains', value: '' }] }
  }

  updateDraftFilter(index: number, patch: Partial<ViewFilterDraft>) {
    const draft = this.draft
    if (!draft || !draft.filters[index]) return
    const filters = draft.filters.slice()
    filters[index] = { ...filters[index]!, ...patch }
    this.draft = { ...draft, filters }
  }

  removeDraftFilter(index: number) {
    const draft = this.draft
    if (!draft) return
    this.draft = { ...draft, filters: draft.filters.filter((_, item) => item !== index) }
  }

  /** Create or update the view described by the editor draft. */
  async saveDraft() {
    const draft = this.draft
    const vault = this.vault
    const fs = vault?.fs
    if (!draft || !vault || !fs) return
    const view = buildViewFromDraft(draft)
    if (!view) {
      vault.error = 'Name the view first.'
      return
    }
    const taken = new Set(this.views.map((item) => item.file).filter((file) => file !== draft.file))
    const file = dedupeViewSlug(viewSlug(view.name), taken)
    // Capture before reload(): a rename deletes the old slug, and reload resets
    // a dangling `view:<slug>` filter to 'all' — so the check must happen first.
    const wasActive = draft.file !== '' && vault.listFilter === `${VIEW_FILTER_PREFIX}${draft.file}`
    try {
      await this.writeThrough(async () => {
        await writeViewFile(fs, file, view)
        if (draft.file !== '' && draft.file !== file) await removeViewFile(fs, draft.file)
        const order = this.views.map((item) => (item.file === draft.file ? file : item.file))
        if (draft.file === '') order.push(file)
        await writeViewsOrder(fs, order)
      })
      this.draft = null
      await this.reload()
      // A rename moves the slug; keep the view active across the rename.
      if (wasActive) vault.setFilter(`${VIEW_FILTER_PREFIX}${file}`)
      vault.error = ''
    } catch (error) {
      vault.error = errorText(error)
    }
  }

  async deleteView(file: string) {
    const vault = this.vault
    const fs = vault?.fs
    if (!vault || !fs || !this.byFile(file)) return
    try {
      await this.writeThrough(async () => {
        await removeViewFile(fs, file)
        await writeViewsOrder(fs, this.views.map((item) => item.file).filter((item) => item !== file))
      })
      if (this.draft?.file === file) this.draft = null
      // reload() resets listFilter to 'all' when the active view was deleted.
      await this.reload()
      vault.error = ''
    } catch (error) {
      vault.error = errorText(error)
    }
  }

  /** Drag reorder: move `dragged` to `target`'s slot and persist the order file. */
  async moveView(dragged: string, target: string) {
    const vault = this.vault
    const fs = vault?.fs
    if (!vault || !fs) return
    const files = this.views.map((item) => item.file)
    const next = moveViewBefore(files, dragged, target)
    if (next.join('') === files.join('')) return
    try {
      await this.writeThrough(() => writeViewsOrder(fs, next))
      await this.reload()
      vault.error = ''
    } catch (error) {
      vault.error = errorText(error)
    }
  }

  /** Watch events from our own writes are ignored; the write path already updates state. */
  private async writeThrough(job: () => Promise<void>) {
    this.localWrites += 1
    try {
      await job()
    } finally {
      this.localWrites -= 1
    }
  }

  private async attachWatch() {
    const fs = this.vault?.fs
    if (!fs || !fs.capabilities.watch) return
    try {
      this.stopWatch = await fs.watch('', (event) => {
        if (this.localWrites > 0) return
        if (event.path !== VIEWS_ORDER_PATH && !event.path.startsWith(`${VIEWS_DIR}/`)) return
        void this.reload()
      })
    } catch {
      this.stopWatch = null
    }
  }

  private teardownWatch() {
    const stop = this.stopWatch
    this.stopWatch = null
    stop?.()
  }
}

// Rail tests mount the tree without main.tsx, so the global service must exist on import.
if (!has(ViewsService)) register(ViewsService)
