import { buildAgentContext, loadNotes, notePath, plainText, type VaultToolHost } from '@stride/core'
import { VaultService } from '../vault/vault.service'

export function chatSystemPrompt(vault: VaultService): string {
  const active = vault.active
  const snapshot = buildAgentContext({
    activeNote: active
      ? {
          id: active.id,
          title: active.title,
          type: active.type,
          properties: active.properties,
          text: plainText(active.doc),
        }
      : null,
    openTabs: active ? [{ id: active.id, title: active.title }] : [],
    vault: {
      label: vault.currentVaultLabel,
      noteCount: vault.notes.length,
      titles: vault.notes.map((note) => note.title),
    },
  })
  return `${snapshot}\nYou are Stride, a local vault assistant.`
}

export function chatVaultHost(vault: VaultService): VaultToolHost {
  return {
    get activeNoteId() {
      return vault.activeId || undefined
    },
    readNote(id) {
      const note = vault.notes.find((item) => item.id === id)
      if (!note) throw new Error('Note not found')
      return note
    },
    async writeSerialized(id, serialized) {
      if (!vault.fs) throw new Error('Open a vault first')
      await vault.fs.writeText(notePath(id), serialized)
      vault.adopt(await loadNotes(vault.fs))
    },
    async searchVault(query) {
      const hits = await vault.queryRanked(query)
      return hits.map((hit) => ({
        id: hit.id,
        title: vault.notes.find((note) => note.id === hit.id)?.title ?? hit.id,
        snippet: hit.snippet,
      }))
    },
    listNotes() {
      return vault.notes.map((note) => ({ id: note.id, title: note.title }))
    },
    loadNotes() {
      return vault.notes
    },
    async createNote(title) {
      if (!vault.fs) throw new Error('Open a vault first')
      const before = new Set(vault.notes.map((note) => note.id))
      vault.error = ''
      await vault.createLinkedNote(title)
      if (vault.error) throw new Error(vault.error)
      const created = vault.notes.find((note) => !before.has(note.id))
      if (!created) throw new Error('Could not create the note')
      return created
    },
  }
}
