import { corpusHash, SEARCH_CACHE_DIR, SearchDiskCache } from '@stride/core'
import { MemoryFileSystem, type SearchBackend } from '@stride/platform'
import { describe, expect, it, vi } from 'vitest'
import type { VaultService } from './vault.service'
import { flushDisk, searchSlot } from './vault-search-session'

const identity = { endpoint: 'https://example.com/v1', model: 'fixture-embed', dim: 0 }
const hash = '11'.repeat(32)
const nextHash = '22'.repeat(32)

function vaneSnap(): Uint8Array {
  const bytes = new Uint8Array(17)
  bytes.set(new TextEncoder().encode('VANE_SNAP'), 0)
  new DataView(bytes.buffer).setUint32(9, 1, true)
  return bytes
}

const backend: SearchBackend = {
  upsert: async () => undefined,
  remove: async () => undefined,
  search: async () => [],
  close: async () => undefined,
}

async function openDisk(label: string) {
  const fs = new MemoryFileSystem(label)
  const disk = await SearchDiskCache.open(fs, identity, { sleep: async () => undefined })
  disk.setNote('note-a', hash)
  disk.recompute(disk.liveNotes())
  return { fs, disk }
}

function attach(disk: SearchDiskCache, capture: () => Promise<Uint8Array>) {
  const vault = {} as VaultService
  const slot = searchSlot(vault)
  slot.disk = disk
  slot.session = { backend, restored: false, capture }
  return vault
}

describe('flushDisk snapshot generation', () => {
  it('does not commit a snapshot when live notes change during capture', async () => {
    const { fs, disk } = await openDisk('moved')
    const captured = vaneSnap()
    const vault = attach(disk, async () => {
      disk.setNote('note-a', nextHash)
      disk.recompute(disk.liveNotes())
      return captured
    })
    const flush = vi.spyOn(disk, 'flush')

    await flushDisk(vault, true)

    expect(disk.vectorGap).toBe(0)
    expect(disk.noteHash('note-a')).toBe(nextHash)
    expect(flush).toHaveBeenCalledTimes(1)
    expect(await flush.mock.results[0]?.value).toBe(true)
    expect(flush.mock.calls[0]?.[0]).toEqual({
      live: [{ id: 'note-a', contentHash: nextHash }],
      commit: false,
      snapshot: null,
    })
    expect(await fs.stat(`${SEARCH_CACHE_DIR}/snapshots/1.vane`)).toBeNull()
    expect(await fs.stat(`${SEARCH_CACHE_DIR}/manifest.json`)).toBeNull()
  })

  it('commits the snapshot when live notes stay on the captured generation', async () => {
    const { fs, disk } = await openDisk('stable')
    const captured = vaneSnap()
    const vault = attach(disk, async () => captured)
    const flush = vi.spyOn(disk, 'flush')

    await flushDisk(vault, true)

    expect(flush).toHaveBeenCalledTimes(1)
    expect(await flush.mock.results[0]?.value).toBe(true)
    expect(flush.mock.calls[0]?.[0]).toEqual({
      live: [{ id: 'note-a', contentHash: hash }],
      commit: true,
      snapshot: captured,
    })
    const manifest = JSON.parse(await fs.readText(`${SEARCH_CACHE_DIR}/manifest.json`)) as {
      notes: { id: string; contentHash: string }[]
      snapshot: { corpusHash: string; bytes: number; generation: number; dim: number }
    }
    expect(manifest.notes).toEqual([{ id: 'note-a', contentHash: hash }])
    expect(manifest.snapshot.generation).toBe(1)
    expect(manifest.snapshot.dim).toBe(0)
    expect(manifest.snapshot.bytes).toBe(captured.byteLength)
    expect(manifest.snapshot.corpusHash).toBe(await corpusHash(manifest.notes))
    expect(await fs.readBytes(`${SEARCH_CACHE_DIR}/snapshots/1.vane`)).toEqual(captured)
  })
})
