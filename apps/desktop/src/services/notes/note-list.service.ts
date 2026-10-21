import { has, register, Service } from '@rabjs/react'
import {
  DEFAULT_LIST_SORT,
  readVaultSort,
  rangeSelection,
  toggleInSelection,
  writeVaultSort,
  type ListSort,
  type ListStorage,
} from './note-list'
import { TabsService } from './tabs.service'
import { VaultService } from '../vault/vault.service'

function listStorage(): ListStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

/**
 * Owns the note list's multi-selection and per-vault sort preference.
 *
 * - Click semantics: plain click single-selects and opens the note (through
 *   TabsService, like every browsing surface); Mod+click toggles; Shift+click
 *   extends the range from the last anchor. Esc clears the selection.
 * - Sort is persisted per vault in `stride:list` (versioned, mirroring
 *   `stride:tabs`). VaultService calls `onVaultOpened` at the end of
 *   openBackendBody, once `activeVaultId` is final — the same handover
 *   protocol as TabsService, so no reaction ever sees a mid-open vault.
 * - Batch operations forward to VaultService per-note methods; no file logic
 *   lives here. `confirmingDelete`/`retypeOpen` are service state so the
 *   command palette can drive the same flows as the batch bar buttons.
 */
export class NoteListService extends Service {
  selectedIds: string[] = []
  anchorId = ''
  sort: ListSort = { ...DEFAULT_LIST_SORT }
  /** Bumped when the list should scroll back to top (vault open). */
  scrollEpoch = 0
  confirmingDelete = false
  retypeOpen = false
  /** Vault the currently loaded sort belongs to; '' before the first open. */
  private sortVaultKey = ''

  private get vault(): VaultService | null {
    return has(VaultService) ? this.resolve(VaultService) : null
  }

  get selectionCount(): number {
    return this.selectedIds.length
  }

  /** Multi-selection gates the batch bar and the `hasListSelection` condition. */
  get hasMultiSelection(): boolean {
    return this.selectedIds.length > 1
  }

  isSelected(id: string): boolean {
    return this.selectedIds.includes(id)
  }

  /** Row click entry point. `orderedIds` is the currently rendered order. */
  clickNote(id: string, mods: { shift: boolean; mod: boolean }, orderedIds: readonly string[]) {
    if (mods.shift && this.anchorId) {
      this.selectedIds = rangeSelection(orderedIds, this.anchorId, id)
      return
    }
    if (mods.mod) {
      const wasSelected = this.selectedIds.includes(id)
      this.selectedIds = toggleInSelection(this.selectedIds, id)
      if (!wasSelected) this.anchorId = id
      if (this.selectedIds.length === 1) this.anchorId = this.selectedIds[0]!
      return
    }
    this.selectedIds = [id]
    this.anchorId = id
    const tabs = has(TabsService) ? this.resolve(TabsService) : null
    if (tabs) {
      tabs.openNote(id)
      return
    }
    this.vault?.select(id)
  }

  /**
   * Right-click selection: menus act on the selection, so a right-clicked row
   * that is not selected becomes the whole selection (without opening the
   * note). Already-selected rows keep the selection untouched.
   */
  selectForMenu(id: string) {
    if (this.isSelected(id)) return
    this.selectedIds = [id]
    this.anchorId = id
  }

  clearSelection() {
    if (this.selectedIds.length === 0 && this.anchorId === '') return
    this.selectedIds = []
    this.anchorId = ''
  }

  setSort(sort: ListSort) {
    this.sort = sort
    const vaultId = this.sortVaultKey || this.vault?.activeVaultId || ''
    if (vaultId) writeVaultSort(listStorage(), vaultId, sort)
  }

  /** VaultService calls this at the end of openBackendBody (activeVaultId final). */
  onVaultOpened() {
    this.clearSelection()
    this.confirmingDelete = false
    this.retypeOpen = false
    this.scrollEpoch += 1
    const vaultId = this.vault?.activeVaultId ?? ''
    if (!vaultId) return
    if (vaultId !== this.sortVaultKey) {
      this.sortVaultKey = vaultId
      this.sort = readVaultSort(listStorage(), vaultId)
    }
  }

  async archiveSelected() {
    const vault = this.vault
    const ids = [...this.selectedIds]
    if (!vault || ids.length === 0) return
    await vault.archiveNotes(ids)
    this.clearSelection()
  }

  async deleteSelected() {
    const vault = this.vault
    const ids = [...this.selectedIds]
    this.confirmingDelete = false
    if (!vault || ids.length === 0) return
    await vault.deleteNotes(ids)
    this.clearSelection()
  }

  async retypeSelected(type: string) {
    const vault = this.vault
    const ids = [...this.selectedIds]
    this.retypeOpen = false
    if (!vault || ids.length === 0 || !type.trim()) return
    await vault.retypeNotes(ids, type)
    this.clearSelection()
  }
}

// Tests mount the list without main.tsx, so the global service must exist on import.
if (!has(NoteListService)) register(NoteListService)
