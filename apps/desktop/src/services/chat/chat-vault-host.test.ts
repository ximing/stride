import { has, register, resolve } from '@rabjs/react'
import type { StrideNote } from '@stride/core'
import { describe, expect, it } from 'vitest'
import { chatSystemPrompt, chatVaultHost } from './chat-vault-host'
import { VaultService } from '../vault/vault.service'

const note: StrideNote = {
  id: 'n1',
  title: 'Moss garden',
  type: 'note',
  properties: {},
  doc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'ferns by the wall' }] }] },
}

describe('chatVaultHost', () => {
  it('searches the open vault without writing the search panel query', async () => {
    if (!has(VaultService)) register(VaultService)
    const vault = resolve(VaultService)
    const previousNotes = vault.notes
    const previousQuery = vault.searchQuery
    vault.notes = [note]
    vault.searchQuery = ''
    try {
      const hits = await chatVaultHost(vault).searchVault('Moss')
      expect(hits[0]?.id).toBe('n1')
      expect(hits[0]?.title).toBe('Moss garden')
      expect(hits[0]?.snippet).toContain('Moss')
      expect(vault.searchQuery).toBe('')
    } finally {
      vault.notes = previousNotes
      vault.searchQuery = previousQuery
    }
  })

  it('puts the open note title in the system prompt and leaves keys out', () => {
    const vault = {
      active: note,
      notes: [note],
      currentVaultLabel: 'Field notes',
    } as unknown as VaultService
    const prompt = chatSystemPrompt(vault)
    expect(prompt).toContain('Moss garden')
    expect(prompt).toContain('ferns by the wall')
    expect(prompt).not.toContain('apiKey')
  })

  it('says when no note is open', () => {
    const vault = {
      active: null,
      notes: [],
      currentVaultLabel: '',
    } as unknown as VaultService
    expect(chatSystemPrompt(vault)).toContain('No note is open')
  })

  it('refuses to create a note when no vault is open', async () => {
    const vault = { fs: null, notes: [], activeId: '' } as unknown as VaultService
    await expect(chatVaultHost(vault).createNote('A seed')).rejects.toThrow('Open a vault first')
  })
})
