import { has, raw } from '@rabjs/react'
import { noteIndex, noteRebuilder } from '../../../../../packages/core/src/search'
import { embeddingSignature, indexText, SearchDiskCache } from '../../../../../packages/core/src/search-cache'
import { recoverRename } from '../../../../../packages/core/src/rename-tx'
import {
  readAdvanceInbox,
  readAgentMode,
  readGitSetupPreference,
  readRenameFromHeading,
  readViewMode,
  readZoom,
} from '../../../../../packages/core/src/vault-config'
import { openVault } from '../../../../../packages/core/src/vault'
import { MemoryFileSystem, type FileSystemBackend } from '@stride/platform'
import { isMemoryFixture } from '../platform/runtime'
import { applyStageZoom } from '../layout/stage-zoom'
import { NoteListService } from '../notes/note-list.service'
import { TabsService } from '../notes/tabs.service'
import { ViewsService } from '../views/views.service'
import { bindPagehide, flushDiskNow, openSearchSession, searchSlot, startRebuild } from './vault-search-session'
import { resetPropertyEditor } from './vault-properties'
import type { VaultService } from './vault.service'

// The browser has no home directory. openVault only uses this to reject broad personal roots.
const HOME_DIR = '/Users/stride'

function isTypeDocument(note: { type: string }): boolean {
  return note.type === 'Type'
}

export async function openBackendBody(vault: VaultService, backend: FileSystemBackend) {
  const runtime = await vault.currentEmbedding()
  const dim = runtime.active ? runtime.dim : 0
  await recoverRename(backend)
  const opened = await openVault(backend, HOME_DIR)
  const renameFromHeading = await readRenameFromHeading(backend)
  const advanceInbox = await readAdvanceInbox(backend)
  const agentMode = await readAgentMode(backend)
  const zoom = await readZoom(backend)
  const viewMode = await readViewMode(backend)
  const gitSetupPreference = await readGitSetupPreference(backend)
  vault.rebuildEpoch += 1
  const epoch = vault.rebuildEpoch
  const retiring = vault.index
  const retiringRebuild = vault.rebuildDone
  vault.index = null
  vault.rebuilder = null
  vault.indexWork = 'idle'
  await retiringRebuild.catch(() => undefined)
  await flushDiskNow(vault)
  await retiring?.close().catch(() => undefined)
  const slot = searchSlot(vault)
  slot.session = null
  slot.disk = null
  const cacheIdentity = runtime.active
    ? { endpoint: runtime.endpoint, model: runtime.model, dim: runtime.dim }
    : { endpoint: '', model: '', dim: 0 }
  const signature = await embeddingSignature(cacheIdentity)
  const fsKey = raw(backend)
  if (slot.fsKey !== fsKey || slot.signature !== signature) {
    slot.queries = []
    slot.fsKey = fsKey
    slot.signature = signature
  }
  if (opened.dedicated) {
    try {
      slot.disk = await SearchDiskCache.open(backend, cacheIdentity, { signature })
    } catch {
      console.warn('stride search cache: open-failed')
      slot.disk = null
    }
  }
  const session = await openSearchSession(
    vault,
    backend.rootLabel,
    dim,
    isMemoryFixture() || backend instanceof MemoryFileSystem,
  )
  slot.session = session
  bindPagehide(vault)
  vault.indexSignature = { endpoint: runtime.endpoint, model: runtime.model, dim, active: runtime.active }
  const index = noteIndex(session.backend, dim)
  vault.index = index
  vault.rebuilder = noteRebuilder(index)
  vault.fs = backend
  vault.vaultPath = opened.path
  vault.broad = opened.broad
  vault.notes = opened.notes
  vault.docEpoch += 1
  vault.activeId = opened.notes.find((note) => !isTypeDocument(note))?.id ?? ''
  vault.listFilter = 'all'
  vault.searchHits = []
  vault.searchQuery = ''
  vault.searchMode = ''
  vault.searchDegraded = runtime.intended && !runtime.active
  vault.listFilterService.clear()
  vault.renameFromHeading = renameFromHeading
  vault.agentMode = agentMode
  vault.advanceInbox = advanceInbox
  vault.zoom = zoom
  vault.viewMode = viewMode
  vault.gitSetupPreference = gitSetupPreference
  applyStageZoom(zoom)
  resetPropertyEditor(vault)
  const snapshot = opened.notes.map((note) => ({ id: note.id, text: indexText(note) }))
  vault.indexDone = 0
  vault.indexTotal = snapshot.length
  vault.indexPhase = snapshot.length > 0 ? 'rebuilding' : 'ready'
  vault.phase = 'ready'
  vault.rebuildDone = snapshot.length > 0 ? startRebuild(vault, epoch, snapshot) : Promise.resolve()
  vault.error = ''
  void vault.refreshMtimes(epoch, opened.notes)
  await vault.rememberVault(backend)
  // Tabs restore the per-vault scene only now: activeVaultId became final in
  // rememberVault, so earlier activeId reactions belong to the old vault.
  if (has(TabsService)) vault.resolve(TabsService).onVaultOpened()
  // Same handover for the list: load this vault's persisted sort and drop any
  // selection left over from the previous vault.
  if (has(NoteListService)) vault.resolve(NoteListService).onVaultOpened()
  // Saved views scan `views/*.json` and subscribe to fs watch events (git pull
  // refresh). Awaited so the sidebar is populated before open resolves.
  if (has(ViewsService)) await vault.resolve(ViewsService).onVaultOpened()
  const { SettingsService } = await import('../settings/settings.service')
  if (has(SettingsService)) await vault.resolve(SettingsService).bindUsageVault(backend)
}
