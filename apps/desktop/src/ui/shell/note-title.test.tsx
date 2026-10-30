import { register, resolve } from '@rabjs/react'
import { plainText } from '@stride/core/note'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readNoteFile } from '../../../../../packages/core/src/vault'
import { FolderService } from '../../services/vault/folder.service'
import { VaultService } from '../../services/vault/vault.service'
import { NoteTitleField } from './note-title'

function useMemoryFixture() {
  window.history.replaceState(null, '', '/?fixture=memory')
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

function host(): { element: HTMLDivElement; root: Root } {
  const element = document.createElement('div')
  document.body.appendChild(element)
  return { element, root: createRoot(element) }
}

describe('NoteTitleField', () => {
  afterEach(() => {
    window.history.replaceState(null, '', '/')
  })

  it('keeps a cleared title empty until a real name is committed', async () => {
    useMemoryFixture()
    register(VaultService)
    register(FolderService)
    const vault = resolve(VaultService)
    await vault.openFromDraft()
    await vault.createNote()
    vault.updateTitle('Field notes')
    await vault.commitHeadingRename()
    const id = vault.active?.id ?? ''
    const { element, root } = host()
    try {
      await act(async () => {
        root.render(<NoteTitleField />)
      })
      const input = element.querySelector<HTMLInputElement>('[data-testid="note-title"]')
      expect(input).not.toBeNull()
      expect(input?.getAttribute('aria-label')).toBe('Note title')
      expect(input?.placeholder).toBe('Untitled')

      vault.updateDoc({
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'kept-body' }] }],
      })
      await act(async () => {
        input?.focus()
        setInputValue(input!, '')
      })
      expect(input?.value).toBe('')
      expect(vault.active?.title).toBe('Field notes')

      await act(async () => {
        await vault.flush()
      })
      expect(input?.value).toBe('')
      expect(vault.active?.title).toBe('Field notes')
      const saved = await readNoteFile(vault.fs!, `${id}.stride.json`, id)
      expect(saved.title).toBe('Field notes')
      expect(plainText(saved.doc)).toContain('kept-body')

      await act(async () => {
        setInputValue(input!, '   ')
        input?.blur()
      })
      await act(async () => {
        await vault.flush()
      })
      expect(input?.value).toBe('Field notes')
      expect(vault.active?.id).toBe(id)
      expect(vault.active?.title).toBe('Field notes')

      await act(async () => {
        input?.focus()
        setInputValue(input!, 'Renamed page')
        input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      })
      await vi.waitFor(() => {
        expect(vault.active?.id).toBe('renamed-page')
      })
      expect(vault.active?.title).toBe('Renamed page')
      expect(input?.value).toBe('Renamed page')
    } finally {
      vault.cancelPending()
      await act(async () => {
        root.unmount()
      })
      element.remove()
    }
  })

  it('commits the draft when another note becomes active', async () => {
    useMemoryFixture()
    register(VaultService)
    register(FolderService)
    const vault = resolve(VaultService)
    await vault.openFromDraft()
    await vault.createNote()
    vault.updateTitle('Field notes')
    await vault.commitHeadingRename()
    const firstId = vault.active?.id ?? ''
    await vault.createNote()
    const secondId = vault.active?.id ?? ''
    vault.select(firstId)
    const { element, root } = host()
    try {
      await act(async () => {
        root.render(<NoteTitleField />)
      })
      const input = element.querySelector<HTMLInputElement>('[data-testid="note-title"]')
      await act(async () => {
        input?.focus()
        setInputValue(input!, 'Alpha page')
        vault.select(secondId)
      })
      await vi.waitFor(() => {
        expect(vault.notes.some((note) => note.title === 'Alpha page')).toBe(true)
      })
      expect(vault.active?.id).toBe(secondId)
      expect(vault.notes.find((note) => note.title === 'Alpha page')?.id).toBe('alpha-page')
      expect(input?.value).toBe('Untitled')
    } finally {
      vault.cancelPending()
      await act(async () => {
        root.unmount()
      })
      element.remove()
    }
  })

  it('restores the previous title on Escape', async () => {
    useMemoryFixture()
    register(VaultService)
    register(FolderService)
    const vault = resolve(VaultService)
    await vault.openFromDraft()
    await vault.createNote()
    vault.updateTitle('Field notes')
    await vault.commitHeadingRename()
    const id = vault.active?.id ?? ''
    const { element, root } = host()
    try {
      await act(async () => {
        root.render(<NoteTitleField />)
      })
      const input = element.querySelector<HTMLInputElement>('[data-testid="note-title"]')
      await act(async () => {
        input?.focus()
        setInputValue(input!, 'Nope')
        input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      })
      await act(async () => {
        await vault.flush()
      })
      expect(input?.value).toBe('Field notes')
      expect(vault.active?.id).toBe(id)
      expect(vault.active?.title).toBe('Field notes')
    } finally {
      vault.cancelPending()
      await act(async () => {
        root.unmount()
      })
      element.remove()
    }
  })
})
