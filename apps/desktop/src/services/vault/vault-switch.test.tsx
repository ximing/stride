import { observer, register, resolve, useService } from '@rabjs/react'
import { createNote, plainText, serializeNote, type TipTapNode } from '@stride/core/note'
import { NOTE_READ_CONCURRENCY } from '@stride/core'
import { MemoryFileSystem } from '@stride/platform'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { notePath, readNoteFile } from '../../../../../packages/core/src/vault'
import { VaultSwitcher, VaultSwitchStatus } from '../../ui/shell/rail-chrome'
import { startRebuild } from './vault-search-session'
import * as searchSession from './vault-search-session'
import { VaultService } from './vault.service'

function useMemoryFixture() {
  window.history.replaceState(null, '', '/?fixture=memory')
}

function body(text: string): TipTapNode {
  return { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] }
}

class HoldFs extends MemoryFileSystem {
  noteReads = 0
  inFlight = 0
  maxInFlight = 0
  hold: Promise<void> | null = null

  override async readText(path: string): Promise<string> {
    if (!path.endsWith('.stride.json')) return super.readText(path)
    this.noteReads += 1
    this.inFlight += 1
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight)
    try {
      if (this.hold) await this.hold
      return await super.readText(path)
    } finally {
      this.inFlight -= 1
    }
  }
}

async function writeNote(fs: MemoryFileSystem, id: string, text: string) {
  const note = createNote(id, id)
  note.doc = body(text)
  await fs.writeText(`${id}.stride.json`, serializeNote(note))
}

async function openMemory(): Promise<VaultService> {
  useMemoryFixture()
  vi.stubGlobal('showDirectoryPicker', vi.fn())
  register(VaultService)
  const vault = resolve(VaultService)
  vault.cancelPending()
  await vault.openFromDraft()
  return vault
}

const Probe = observer(function Probe() {
  const vault = useService(VaultService)
  return (
    <>
      <VaultSwitcher />
      <VaultSwitchStatus />
      <div data-testid="switch-probe">{vault.activeVaultId}|{vault.vaultPath}</div>
    </>
  )
})

describe('vault switch feedback and handover', () => {
  const roots: { root: Root; host: HTMLElement }[] = []

  afterEach(() => {
    for (const mounted of roots) {
      mounted.root.unmount()
      mounted.host.remove()
    }
    roots.length = 0
    window.history.replaceState(null, '', '/')
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    try {
      resolve(VaultService).cancelPending()
    } catch {
      // not registered
    }
  })

  async function mount(): Promise<HTMLElement> {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => {
      root.render(<Probe />)
    })
    roots.push({ root, host })
    return host
  }

  it('paints the switching status while a note read is still held', async () => {
    const vault = await openMemory()
    const idA = vault.activeVaultId
    const slow = new HoldFs('slow-vault')
    await writeNote(slow, 'slow-note', 'slow body')
    await vault.openClonedVault(slow)
    const idSlow = vault.activeVaultId
    await vault.switchVault(idA)
    let release!: () => void
    slow.hold = new Promise<void>((resolve) => {
      release = resolve
    })
    slow.noteReads = 0
    const host = await mount()
    const pending = vault.switchVault(idSlow)
    await vi.waitFor(() => {
      expect(slow.noteReads).toBeGreaterThan(0)
    })
    await act(async () => {
      await Promise.resolve()
    })
    const status = host.querySelector('[data-testid="vault-switching"]')
    expect(status?.textContent).toContain('slow-vault')
    expect(status?.getAttribute('role')).toBe('status')
    expect(host.querySelector('[data-testid="vault-switcher"]')?.getAttribute('aria-busy')).toBe('true')
    expect(vault.activeVaultId).toBe(idA)
    expect(vault.fs?.rootLabel).not.toBe('slow-vault')
    release()
    slow.hold = null
    await act(async () => {
      await pending
    })
    expect(host.querySelector('[data-testid="vault-switching"]')).toBeNull()
    expect(host.querySelector('[data-testid="vault-switcher"]')?.getAttribute('aria-busy')).toBeNull()
    expect(vault.activeVaultId).toBe(idSlow)
    expect(vault.notes.some((note) => note.id === 'slow-note')).toBe(true)
    expect(vault.error).toBe('')
  })

  it('clears the status after a failed search open and can switch again', async () => {
    const vault = await openMemory()
    await vault.createNote()
    const idA = vault.activeVaultId
    const other = new MemoryFileSystem('other-vault')
    await writeNote(other, 'other-note', 'other body')
    await vault.openClonedVault(other)
    const idOther = vault.activeVaultId
    await vault.switchVault(idA)
    await vault.rebuildDone
    const fsA = vault.fs
    const index = vault.index
    let release!: (error?: unknown) => void
    let entered!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const gate = new Promise<void>((resolve, reject) => {
      release = (error) => {
        if (error) reject(error)
        else resolve()
      }
    })
    const spy = vi.spyOn(searchSession, 'openSearchSession').mockImplementation(async () => {
      entered()
      await gate
      throw new Error('open failed')
    })
    const host = await mount()
    const pending = vault.switchVault(idOther)
    await started
    await act(async () => {
      await Promise.resolve()
    })
    expect(host.querySelector('[data-testid="vault-switching"]')?.textContent).toContain('other-vault')
    expect(vault.activeVaultId).toBe(idA)
    release(new Error('open failed'))
    await act(async () => {
      await pending
    })
    expect(host.querySelector('[data-testid="vault-switching"]')).toBeNull()
    expect(vault.activeVaultId).toBe(idA)
    expect(vault.fs).toBe(fsA)
    expect(vault.index).toBe(index)
    expect(vault.error).toMatch(/open failed/)
    spy.mockRestore()
    await act(async () => {
      await vault.switchVault(idOther)
    })
    expect(vault.activeVaultId).toBe(idOther)
    expect(vault.notes.some((note) => note.id === 'other-note')).toBe(true)
    expect(vault.error).toBe('')
    expect(host.querySelector('[data-testid="vault-switching"]')).toBeNull()
  })

  it('keeps an unsaved note on the vault being left', async () => {
    const vault = await openMemory()
    await vault.createNote()
    const id = vault.activeId
    const left = vault.fs!
    const idHome = vault.activeVaultId
    vault.updateDoc(body('seed'))
    await vault.flush()
    const other = new MemoryFileSystem('kept-other')
    await writeNote(other, 'kept-else', 'elsewhere')
    await vault.openClonedVault(other)
    const idOther = vault.activeVaultId
    await vault.switchVault(idHome)
    vault.updateDoc(body('unsaved-words'))
    expect(vault.pendingId).toBe(id)
    await vault.switchVault(idOther)
    const saved = await readNoteFile(left, notePath(id), id)
    expect(plainText(saved.doc)).toContain('unsaved-words')
    expect(vault.fs?.rootLabel).toBe('kept-other')
    expect(vault.notes.some((note) => note.id === id)).toBe(false)
    expect(vault.notes.some((note) => note.id === 'kept-else')).toBe(true)
  })

  it('does not publish a superseded vault or read every one of its notes', async () => {
    const vault = await openMemory()
    const idA = vault.activeVaultId
    const skipped = new HoldFs('rapid-b')
    for (let index = 0; index < 24; index += 1) {
      await writeNote(skipped, `b-${String(index).padStart(2, '0')}`, 'from b')
    }
    const next = new MemoryFileSystem('rapid-c')
    await writeNote(next, 'c-note', 'from c')
    await vault.openClonedVault(skipped)
    const idB = vault.activeVaultId
    await vault.openClonedVault(next)
    const idC = vault.activeVaultId
    await vault.switchVault(idA)
    skipped.noteReads = 0
    let release!: () => void
    skipped.hold = new Promise<void>((resolve) => {
      release = resolve
    })
    const generation = vault.openGeneration
    const toB = vault.switchVault(idB)
    await vi.waitFor(() => {
      expect(skipped.noteReads).toBeGreaterThan(0)
    })
    const toC = vault.switchVault(idC)
    await vi.waitFor(() => {
      expect(vault.openGeneration).toBeGreaterThan(generation + 1)
    })
    release()
    skipped.hold = null
    await Promise.all([toB, toC])
    expect(vault.activeVaultId).toBe(idC)
    expect(vault.vaultPath).toBe('rapid-c')
    expect(vault.notes.map((note) => note.id)).toEqual(['c-note'])
    expect(skipped.noteReads).toBeGreaterThan(0)
    expect(skipped.noteReads).toBeLessThanOrEqual(NOTE_READ_CONCURRENCY)
    expect(skipped.maxInFlight).toBeLessThanOrEqual(NOTE_READ_CONCURRENCY)
    expect(vault.error).toBe('')
  })

  it('does not wait to publish for a previous rebuild that resolves later', async () => {
    const vault = await openMemory()
    const home = vault.vaults.find((entry) => entry.id === vault.activeVaultId)!
    const other = new MemoryFileSystem('later-vault')
    await writeNote(other, 'later-note', 'later')
    await vault.openClonedVault(other)
    const idOther = vault.activeVaultId
    await vault.switchVault(home.id)
    await vault.rebuildDone
    const oldIndex = vault.index
    let resolveOld!: () => void
    vault.rebuildDone = new Promise<void>((resolve) => {
      resolveOld = resolve
    })
    vault.indexPhase = 'rebuilding'
    const started = performance.now()
    const pending = vault.switchVault(idOther)
    const winner = await Promise.race([
      pending.then(() => 'done' as const),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 500)),
    ])
    expect(winner).toBe('done')
    expect(performance.now() - started).toBeLessThan(500)
    expect(vault.activeVaultId).toBe(idOther)
    expect(vault.index).not.toBe(oldIndex)
    expect(vault.notes.some((note) => note.id === 'later-note')).toBe(true)
    resolveOld()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(vault.activeVaultId).toBe(idOther)
    expect(vault.index).not.toBe(oldIndex)
    expect(vault.fs?.rootLabel).toBe('later-vault')
  })

  it('drops a late rebuild continuation after the epoch moves on', async () => {
    const vault = await openMemory()
    await vault.createNote()
    await vault.rebuildDone
    const real = vault.currentEmbedding.bind(vault)
    let calls = 0
    let release!: () => void
    let entered!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    vault.currentEmbedding = async () => {
      calls += 1
      if (calls >= 2) {
        entered()
        await new Promise<void>((resolve) => {
          release = resolve
        })
      }
      return real()
    }
    const pending = startRebuild(vault, vault.rebuildEpoch, [{ id: vault.activeId, text: 'late text' }])
    await started
    vault.rebuildEpoch += 1
    vault.indexPhase = 'rebuilding'
    vault.indexWork = 'indexing'
    release()
    await pending
    expect(vault.indexPhase).toBe('rebuilding')
    expect(vault.indexWork).toBe('indexing')
    expect(calls).toBeGreaterThanOrEqual(2)
  })
})
