import { register, resolve } from '@rabjs/react'
import { createNote, parseNote, plainText, serializeNote, type StrideNote } from '@stride/core/note'
import { notePath } from '@stride/core'
import { MemoryFileSystem } from '@stride/platform'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NoteEditor } from './editor'
import type { DiskConflict } from '../services/vault/vault-refresh'
import { VaultService } from '../services/vault/vault.service'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const roots: Root[] = []
const hosts: HTMLElement[] = []

function body(text: string) {
  return { type: 'doc' as const, content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] }
}

async function mount(text: string, conflict?: DiskConflict) {
  register(VaultService)
  const vault = resolve(VaultService)
  const note = createNote('moss', 'Moss')
  note.doc = body(text)
  vault.notes = [note]
  vault.activeId = note.id
  vault.pendingId = ''
  vault.docEpoch = 0
  vault.diskConflicts = conflict ? [conflict] : []
  vault.fs = new MemoryFileSystem('memory-vault')
  await vault.fs.writeText(notePath(note.id), serializeNote(note))
  const host = document.createElement('div')
  document.body.appendChild(host)
  hosts.push(host)
  const root = createRoot(host)
  roots.push(root)
  await act(async () => {
    root.render(<NoteEditor />)
  })
  return { vault, host, note }
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await act(async () => root.unmount())
  }
  hosts.splice(0).forEach((host) => host.remove())
  vi.restoreAllMocks()
})

function diskNote(title: string, text: string): StrideNote {
  const note = createNote('moss', title)
  note.doc = body(text)
  return note
}

describe('editor disk conflict banner', () => {
  it('sits above the editor and offers Keep draft and Load disk', async () => {
    const { host } = await mount('draft text', {
      id: 'moss',
      mtimeMs: 40,
      size: 12,
      note: diskNote('From disk', 'disk text'),
      undoable: true,
    })
    const editor = host.querySelector('[data-testid="editor"]')
    const banner = host.querySelector('[data-testid="editor-disk-conflict"]')
    expect(editor?.firstElementChild).toBe(banner)
    expect(banner?.textContent).toContain('This note changed on disk')
    expect(banner?.querySelectorAll('button')).toHaveLength(2)
    expect(host.querySelector('[data-testid="editor-disk-conflict-keep"]')?.textContent).toBe('Keep draft')
    expect(host.querySelector('[data-testid="editor-disk-conflict-load"]')?.textContent).toBe('Load disk')
  })

  it('hides Load disk when the conflict has no body', async () => {
    const { host } = await mount('draft text', {
      id: 'moss',
      mtimeMs: null,
      size: null,
      note: null,
      undoable: false,
    })
    const banner = host.querySelector('[data-testid="editor-disk-conflict"]')
    expect(banner?.textContent).toContain('gone from disk')
    expect(banner?.querySelectorAll('button')).toHaveLength(1)
    expect(host.querySelector('[data-testid="editor-disk-conflict-load"]')).toBeNull()
  })

  it('keeps the draft on disk and loads the captured note without writing', async () => {
    const vaultOnly = await mount('draft text')
    const fs = vaultOnly.vault.fs!
    const disk = diskNote('From disk', 'disk text')
    await fs.writeText(notePath('moss'), serializeNote(disk))
    const observed = (await fs.stat(notePath('moss')))?.mtimeMs ?? 0
    vaultOnly.vault.noteMtimes = { moss: observed }
    vaultOnly.vault.pendingId = 'moss'
    vaultOnly.vault.updateDoc(body('kept draft'))
    vaultOnly.vault.diskConflicts = [{ id: 'moss', mtimeMs: observed, size: 20, note: disk, undoable: true }]
    await act(async () => {
      await Promise.resolve()
    })
    const writes = vi.spyOn(fs, 'writeText')
    const epoch = vaultOnly.vault.docEpoch

    await act(async () => {
      vaultOnly.host.querySelector<HTMLButtonElement>('[data-testid="editor-disk-conflict-load"]')?.click()
    })
    expect(writes).not.toHaveBeenCalled()
    expect(vaultOnly.host.querySelector('[data-testid="editor-disk-conflict"]')).toBeNull()
    expect(vaultOnly.vault.active?.title).toBe('From disk')
    expect(plainText(vaultOnly.vault.active!.doc)).toContain('disk text')
    expect(vaultOnly.vault.docEpoch).toBe(epoch + 1)
    expect(vaultOnly.vault.noteMtimes.moss).toBe(observed)
    expect(await fs.readText(notePath('moss'))).toContain('From disk')

    vaultOnly.vault.updateDoc(body('kept draft'))
    await fs.writeText(notePath('moss'), serializeNote(disk))
    const again = (await fs.stat(notePath('moss')))?.mtimeMs ?? 0
    vaultOnly.vault.noteMtimes = { moss: 1 }
    vaultOnly.vault.diskConflicts = [{ id: 'moss', mtimeMs: again, size: 20, note: disk, undoable: true }]
    await act(async () => {
      await Promise.resolve()
    })
    writes.mockClear()
    await act(async () => {
      vaultOnly.host.querySelector<HTMLButtonElement>('[data-testid="editor-disk-conflict-keep"]')?.click()
      await vi.waitFor(() => {
        expect(vaultOnly.vault.diskConflicts).toEqual([])
        expect(vaultOnly.vault.saveStatus === 'saved' || vaultOnly.vault.saveStatus === 'idle').toBe(true)
      })
    })
    const saved = parseNote(await fs.readText(notePath('moss')), 'moss')
    expect(plainText(saved.doc)).toContain('kept draft')
    expect(vaultOnly.vault.noteMtimes.moss).toBe((await fs.stat(notePath('moss')))?.mtimeMs)
    expect(writes).toHaveBeenCalled()
  })
})
