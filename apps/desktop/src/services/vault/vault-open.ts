import { has, raw } from '@rabjs/react'
import {
  embeddingSignature,
  indexText,
  loadNotesWhile,
  noteIndex,
  noteRebuilder,
  openVaultRoot,
  readVaultOpenState,
  recoverRename,
  SearchDiskCache,
  type NoteIndex,
} from '@stride/core'
import { MemoryFileSystem, type FileSystemBackend, type SearchBackend } from '@stride/platform'
import { hostHomeDirectory } from '../platform/home'
import { isMemoryFixture } from '../platform/runtime'
import { applyStageZoom } from '../layout/stage-zoom'
import { NoteListService } from '../notes/note-list.service'
import { TabsService } from '../notes/tabs.service'
import { ViewsService } from '../views/views.service'
import { bindPagehide, openSearchSession, retireSearch, searchSlot, startRebuild } from './vault-search-session'
import { resetPropertyEditor } from './vault-properties'
import type { VaultService } from './vault.service'

function isTypeDocument(note: { type: string }): boolean {
  return note.type === 'Type'
}

async function closeBackend(backend: SearchBackend | null | undefined) {
  if (!backend) return
  await backend.close().catch(() => undefined)
}

async function resumeRetiredRebuild(
  vault: VaultService,
  ticket: number,
  retiring: NoteIndex | null,
  retiringRebuild: Promise<void>,
  wasRebuilding: boolean,
) {
  if (!wasRebuilding) return
  if (vault.openGeneration !== ticket) return
  if (vault.index !== retiring) return
  await retiringRebuild.catch(() => undefined)
  if (vault.openGeneration !== ticket) return
  if (vault.index !== retiring) return
  const snapshot = vault.notes.map((note) => ({ id: note.id, text: indexText(note) }))
  vault.indexDone = 0
  vault.indexTotal = snapshot.length
  vault.indexPhase = snapshot.length > 0 ? 'rebuilding' : 'ready'
  vault.indexWork = 'idle'
  vault.rebuildDone = snapshot.length > 0
    ? startRebuild(vault, vault.rebuildEpoch, snapshot)
    : Promise.resolve()
}

export async function openBackendBody(vault: VaultService, backend: FileSystemBackend, ticket: number) {
  if (ticket !== vault.openGeneration) return
  // Monotonic for this open. In-flight saves and upserts captured the previous value.
  vault.session += 1
  const retiringIndex = vault.index
  const retiringRebuild = vault.rebuildDone
  const wasRebuilding = vault.indexPhase === 'rebuilding'
  const retiringSlot = searchSlot(vault)
  const retiredDisk = retiringSlot.disk
  const retiredCapture = retiringSlot.session?.capture ?? null
  const retiredReady = vault.indexPhase === 'ready'
  // The previous rebuild reads this epoch. Bumping before the note load lets its
  // abort overlap the open instead of sitting on the path to the first paint.
  vault.rebuildEpoch += 1
  const epoch = vault.rebuildEpoch
  const current = () => vault.openGeneration === ticket
  let sessionToClose: SearchBackend | null = null
  let abandoned = false
  try {
    const prepared = Promise.all([
      vault.currentEmbedding(),
      hostHomeDirectory(),
      recoverRename(backend),
    ])
    const [runtime, home] = await prepared
    if (!current()) return
    const dim = runtime.active ? runtime.dim : 0
    const root = await openVaultRoot(backend, home)
    if (!current()) return
    const cacheIdentity = runtime.active
      ? { endpoint: runtime.endpoint, model: runtime.model, dim: runtime.dim }
      : { endpoint: '', model: '', dim: 0 }
    const searchTask = (async () => {
      const signature = await embeddingSignature(cacheIdentity)
      let disk: SearchDiskCache | null = null
      if (root.dedicated) {
        try {
          disk = await SearchDiskCache.open(backend, cacheIdentity, { signature })
        } catch {
          console.warn('stride search cache: open-failed')
          disk = null
        }
      }
      if (abandoned || !current()) return { disk, session: null, signature }
      const session = await openSearchSession(
        vault,
        backend.rootLabel,
        dim,
        isMemoryFixture() || backend instanceof MemoryFileSystem,
        disk,
      )
      if (abandoned || !current()) {
        await closeBackend(session.backend)
        return { disk, session: null, signature }
      }
      sessionToClose = session.backend
      return { disk, session, signature }
    })()
    const [state, openedSearch, notes] = await Promise.all([
      readVaultOpenState(backend),
      searchTask,
      loadNotesWhile(backend, current),
    ])
    if (!openedSearch.session || notes === null || !current()) {
      abandoned = true
      await closeBackend(sessionToClose)
      sessionToClose = null
      return
    }
    // Past this point the open publishes. A newer request waits on the queue and
    // replaces this vault after the publish; bailing mid-assign would split fs and activeId.
    sessionToClose = null
    const index = noteIndex(openedSearch.session.backend, dim)
    const rebuilder = noteRebuilder(index)
    const slot = searchSlot(vault)
    if (slot.flushTimer) {
      clearTimeout(slot.flushTimer)
      slot.flushTimer = null
    }
    vault.index = index
    vault.rebuilder = rebuilder
    vault.indexWork = 'idle'
    const fsKey = raw(backend)
    if (slot.fsKey !== fsKey || slot.signature !== openedSearch.signature) {
      slot.queries = []
      slot.fsKey = fsKey
      slot.signature = openedSearch.signature
    }
    slot.session = openedSearch.session
    slot.disk = openedSearch.disk
    bindPagehide(vault)
    vault.indexSignature = { endpoint: runtime.endpoint, model: runtime.model, dim, active: runtime.active }
    vault.fs = backend
    vault.vaultPath = root.path
    vault.broad = root.broad
    vault.notes = notes
    vault.docEpoch += 1
    vault.listFilter = 'all'
    vault.searchHits = []
    vault.searchQuery = ''
    vault.searchMode = ''
    vault.searchDegraded = runtime.intended && !runtime.active
    vault.listFilterService.clear()
    vault.renameFromHeading = state.renameFromHeading
    vault.agentMode = state.agentMode
    vault.advanceInbox = state.advanceInbox
    vault.zoom = state.zoom
    vault.viewMode = state.viewMode
    vault.gitSetupPreference = state.gitSetupPreference
    vault.tagColors = state.tagColors
    applyStageZoom(state.zoom)
    resetPropertyEditor(vault)
    const snapshot = notes.map((note) => ({ id: note.id, text: indexText(note) }))
    vault.indexDone = 0
    vault.indexTotal = snapshot.length
    vault.indexPhase = snapshot.length > 0 ? 'rebuilding' : 'ready'
    vault.phase = 'ready'
    vault.rebuildDone = snapshot.length > 0 ? startRebuild(vault, epoch, snapshot) : Promise.resolve()
    vault.error = ''
    void vault.refreshMtimes(epoch, notes)
    retireSearch(retiringRebuild, {
      disk: retiredDisk,
      capture: retiredCapture,
      commit: retiredReady && (retiredDisk?.vectorGap ?? 1) === 0,
      index: retiringIndex,
    })
    await vault.rememberVault(backend)
    // activeVaultId is final only after rememberVault. Publishing activeId earlier
    // lets the tab reaction write the new note into the previous vault's stride:tabs.
    vault.activeId = notes.find((note) => !isTypeDocument(note))?.id ?? ''
    if (has(TabsService)) vault.resolve(TabsService).onVaultOpened()
    // Same handover for the list: load this vault's persisted sort and drop any
    // selection left over from the previous vault.
    if (has(NoteListService)) vault.resolve(NoteListService).onVaultOpened()
    // Saved views scan `views/*.json` and subscribe to fs watch events (git pull
    // refresh). Awaited so the sidebar is populated before open resolves.
    if (has(ViewsService)) await vault.resolve(ViewsService).onVaultOpened()
    const { SettingsService } = await import('../settings/settings.service')
    if (has(SettingsService)) await vault.resolve(SettingsService).bindUsageVault(backend)
  } catch (error) {
    abandoned = true
    await closeBackend(sessionToClose)
    sessionToClose = null
    await resumeRetiredRebuild(vault, ticket, retiringIndex, retiringRebuild, wasRebuilding)
    if (!current()) return
    throw error
  }
}
