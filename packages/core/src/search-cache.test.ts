import { describe, expect, it } from 'vitest'
import { MemoryFileSystem, PlatformError, type FileSystemBackend } from '@stride/platform'
import { createNote } from './note.ts'
import {
  INDEX_TEXT_ALGO,
  SEARCH_CACHE_DIR,
  VECTOR_SHARD_RECORDS,
  atomicWrite,
  canonicalEmbeddingEndpoint,
  corpusHash,
  crc32,
  embeddingSignature,
  encodeVectorBlob,
  hashIndexText,
  hashIndexTexts,
  hotRestoreUpserts,
  indexText,
  isExistsConflict,
  isVaneSnapshot,
  parseVectorBlob,
  planSync,
  readValidFile,
  SearchDiskCache,
  type BaselineNote,
  type CacheNote,
  type EmbeddingIdentity,
  type VectorRecord,
} from './search-cache.ts'

const identity: EmbeddingIdentity = {
  endpoint: 'https://api.example.com/v1/',
  model: 'fixture-embed',
  dim: 4,
}

function note(id: string, contentHash: string, text = id): CacheNote {
  return { id, text, contentHash }
}

function record(dim: number, hashHex: string, values: number[]): VectorRecord {
  const hash = new Uint8Array(32)
  for (let index = 0; index < 32; index += 1) hash[index] = Number.parseInt(hashHex.slice(index * 2, index * 2 + 2), 16)
  return { hash, vector: Float32Array.from(values) }
}

function recordCount(bytes: Uint8Array, dim: number): number {
  const size = 32 + dim * 4 + 4
  if (bytes.byteLength < 16) return 0
  return Math.floor((bytes.byteLength - 16) / size)
}

function vaneSnap(extra = 4): Uint8Array {
  const bytes = new Uint8Array(13 + extra)
  bytes.set(new TextEncoder().encode('VANE_SNAP'), 0)
  new DataView(bytes.buffer).setUint32(9, 1, true)
  return bytes
}

async function openCache(fs: FileSystemBackend, next: EmbeddingIdentity = identity, now = () => 1_000_000) {
  return SearchDiskCache.open(fs, next, { now, sleep: async () => undefined })
}

class DeleteThenThrowFs extends MemoryFileSystem {
  async rename(from: string, to: string): Promise<void> {
    if (await this.stat(to)) await this.remove(to)
    throw new PlatformError('io', 'disk io')
  }
}

class ThrowIoKeepDestFs extends MemoryFileSystem {
  async rename(from: string, to: string): Promise<void> {
    if (await this.stat(to)) throw new PlatformError('io', 'disk io')
    await super.rename(from, to)
  }
}

class CountingFs extends MemoryFileSystem {
  removed: string[] = []
  override async remove(path: string): Promise<void> {
    this.removed.push(path)
    await super.remove(path)
  }
}

class GateFs extends MemoryFileSystem {
  private blocked: Promise<void>
  releaseBlock: () => void
  armed = true
  constructor() {
    super('gate')
    let release: () => void = () => undefined
    this.blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    this.releaseBlock = release
  }

  override async writeBytes(path: string, data: Uint8Array): Promise<void> {
    if (this.armed && path.endsWith('/shards/open.bin.tmp')) {
      this.armed = false
      await this.blocked
    }
    await super.writeBytes(path, data)
  }
}

async function waitUntil(check: () => Promise<boolean> | boolean): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('timed out waiting for the cache lock')
}

describe('search cache bytes', () => {
  it('round-trips a 1536-d SEMB record and skips a bad crc or a short tail', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926)
    const hash = 'ab'.repeat(32)
    const values = Array.from({ length: 1536 }, (_, index) => (index === 0 ? 0.5 : index === 1 ? -1 : 0))
    const blob = encodeVectorBlob(1536, [record(1536, hash, values)])
    expect(blob.byteLength).toBe(16 + 6180)
    const parsed = parseVectorBlob(blob, 1536)
    expect(parsed).toHaveLength(1)
    expect(Array.from(parsed[0]!.vector).slice(0, 2)).toEqual([0.5, -1])

    const broken = blob.slice()
    const view = new DataView(broken.buffer)
    view.setUint32(16 + 32 + 1536 * 4, 0x11111111, true)
    expect(parseVectorBlob(broken, 1536)).toEqual([])

    const second = encodeVectorBlob(4, [
      record(4, '11'.repeat(32), [1, 0, 0, 0]),
      record(4, '22'.repeat(32), [0, 1, 0, 0]),
    ])
    const tail = second.slice(0, second.byteLength - 10)
    expect(parseVectorBlob(tail, 4)).toHaveLength(1)
    expect(parseVectorBlob(second, 8)).toEqual([])
  })

  it('promotes a valid tmp and ignores a truncated one', async () => {
    const fs = new MemoryFileSystem('tmp')
    const blob = encodeVectorBlob(4, [record(4, 'aa'.repeat(32), [1, 2, 3, 4])])
    await fs.writeBytes('open.bin.tmp', blob)
    const promoted = await readValidFile(fs, 'open.bin', (bytes) => parseVectorBlob(bytes, 4).length === 1)
    expect(promoted?.byteLength).toBe(blob.byteLength)
    expect(await fs.stat('open.bin.tmp')).toBeNull()

    await fs.writeBytes('half.bin.tmp', blob.slice(0, 20))
    expect(await readValidFile(fs, 'half.bin', (bytes) => parseVectorBlob(bytes, 4).length === 1)).toBeNull()
    expect(await fs.stat('half.bin')).toBeNull()
  })

  it('keeps the good file when rename fails for a reason other than an exists conflict', async () => {
    const good = new TextEncoder().encode('good-bytes')
    const next = new TextEncoder().encode('next-bytes')
    const deleting = new DeleteThenThrowFs('delete-then-throw')
    await deleting.writeBytes('pack.bin', good)
    await expect(atomicWrite(deleting, 'pack.bin', next)).rejects.toThrow('disk io')
    expect(await deleting.stat('pack.bin')).toBeNull()
    expect((await deleting.stat('pack.bin.tmp'))?.kind).toBe('file')
    const recovered = await readValidFile(deleting, 'pack.bin', (bytes) => bytes.byteLength === next.byteLength)
    expect(new TextDecoder().decode(recovered!)).toBe('next-bytes')

    const keeping = new ThrowIoKeepDestFs('throw-io')
    await keeping.writeBytes('pack.bin', good)
    await expect(atomicWrite(keeping, 'pack.bin', next)).rejects.toThrow('disk io')
    expect(new TextDecoder().decode(await keeping.readBytes('pack.bin'))).toBe('good-bytes')
    const preferred = await readValidFile(keeping, 'pack.bin', () => true)
    expect(new TextDecoder().decode(preferred!)).toBe('good-bytes')
    expect(isExistsConflict(new PlatformError('already-exists', 'busy'))).toBe(true)
    expect(isExistsConflict(new Error('os error 183'))).toBe(true)
    expect(isExistsConflict(new Error('ERROR_ALREADY_EXISTS'))).toBe(true)
    expect(isExistsConflict(new Error('file already exists'))).toBe(true)
    expect(isExistsConflict(new PlatformError('io', 'disk io'))).toBe(false)
  })
})

describe('search cache plan', () => {
  it('hashes index text without properties and canonicalizes the endpoint', async () => {
    const doc = createNote('alpha', 'Title')
    doc.properties = { secret: 'hidden-property' }
    doc.doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'body text' }] }] }
    expect(indexText(doc)).toBe('Title\nbody text')
    expect(indexText(doc)).not.toContain('hidden-property')
    expect(INDEX_TEXT_ALGO).toBe(1)
    const left = await embeddingSignature({ endpoint: 'https://example.com/v1/', model: ' M ', dim: 4 })
    const right = await embeddingSignature({ endpoint: 'https://example.com/v1', model: 'M', dim: 4 })
    expect(left).toBe(right)
    expect(left).toMatch(/^[0-9a-f]{64}$/)
    const other = await embeddingSignature({ endpoint: 'https://example.com/v1', model: 'Other', dim: 4 })
    expect(other).not.toBe(left)
    expect(canonicalEmbeddingEndpoint('https://user:pw@Example.com:443/V1/?x=1')).toBe('https://example.com/V1')
  })

  it('plans adds, edits, deletes, and a text-stable id that has no record', async () => {
    const same = 'aa'.repeat(32)
    const changed = 'bb'.repeat(32)
    const previous = 'cc'.repeat(32)
    const fresh = 'dd'.repeat(32)
    const missing = 'ee'.repeat(32)
    const have = new Set([same, changed])
    const baseline: BaselineNote[] = [
      { id: 'gone', contentHash: 'ff'.repeat(32) },
      { id: 'stable', contentHash: same },
      { id: 'edited', contentHash: previous },
      { id: 'gap', contentHash: missing },
    ]
    const current = [
      note('edited', changed),
      note('fresh', fresh),
      note('gap', missing),
      note('stable', same),
    ]
    const plan = planSync(current, baseline, (hash) => have.has(hash), true)
    expect(plan.restoreSnapshot).toBe(true)
    expect(plan.remove).toEqual(['gone'])
    expect(plan.unchanged).toEqual(['stable'])
    expect(plan.cached.map((item) => item.id)).toEqual(['edited'])
    expect(plan.embed.map((item) => item.id).sort()).toEqual(['fresh', 'gap'])
    expect(plan.embed).toHaveLength(2)

    const cold = planSync(current, baseline, (hash) => have.has(hash), false)
    expect(cold.unchanged).toEqual([])
    expect(cold.remove).toEqual([])
    expect(cold.cached.map((item) => item.id)).toEqual(['edited', 'stable'])
    expect(cold.embed.map((item) => item.id)).toEqual(['fresh', 'gap'])
  })

  it('does not treat a manifest hash without a pack record as a hit', async () => {
    const fs = new MemoryFileSystem('manifest-miss')
    const cache = await openCache(fs)
    const present = await hashIndexText('present')
    const missing = await hashIndexText('missing')
    expect(cache.remember(present, [1, 0, 0, 0])).toBe(true)
    expect(cache.remember(missing, [0, 0, 0, 0])).toBe(false)
    expect(await cache.flush({
      live: [{ id: 'present', contentHash: present }],
      commit: true,
      snapshot: vaneSnap(),
    })).toBe(true)
    const manifest = JSON.parse(await fs.readText(`${SEARCH_CACHE_DIR}/manifest.json`)) as {
      notes: BaselineNote[]
      snapshot: { generation: number; corpusHash: string; bytes: number; dim: number }
    }
    expect(manifest.notes.map((item) => item.id)).toEqual(['present'])
    expect(manifest.snapshot.generation).toBe(1)
    manifest.notes.push({ id: 'missing', contentHash: missing })
    manifest.notes.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
    manifest.snapshot.corpusHash = await corpusHash(manifest.notes)
    await fs.writeText(`${SEARCH_CACHE_DIR}/manifest.json`, `${JSON.stringify(manifest)}\n`)

    const again = await openCache(fs)
    expect(again.haveVector(missing)).toBe(false)
    await again.loadPackIfNeeded([present, missing])
    expect(again.haveVector(present)).toBe(true)
    expect(again.haveVector(missing)).toBe(false)
    const current = [
      note('present', present),
      note('missing', missing),
    ]
    const plan = again.plan(current, await again.snapshotUsable(4))
    expect(plan.unchanged).toEqual(['present'])
    expect(plan.embed.map((item) => item.id)).toEqual(['missing'])
    expect(again.vectorGap).toBe(1)
    expect(plan.embed.some((item) => item.id === 'present')).toBe(false)
  })

  it('writes one record when two notes share text and omits placeholder zeros', async () => {
    const fs = new MemoryFileSystem('dedupe')
    const cache = await openCache(fs)
    const hash = await hashIndexText('same body')
    expect(cache.remember(hash, [0, 0, 0, 0])).toBe(false)
    expect(cache.remember(hash, [0, 0, 0, 0], true)).toBe(true)
    const zero = await hashIndexText('real zero')
    cache.removeNote('unused')
    expect(cache.remember(zero, [0, 0, 0, 0], true)).toBe(true)
    const other = await hashIndexText('other')
    expect(cache.remember(other, [1, 0, 0, 0])).toBe(true)
    expect(await cache.flush({
      live: [
        { id: 'b', contentHash: hash },
        { id: 'a', contentHash: hash },
      ],
      commit: true,
    })).toBe(true)
    const pack = await fs.readBytes(`${SEARCH_CACHE_DIR}/vectors/${cache.signature}/pack.bin`)
    expect(recordCount(pack, 4)).toBe(1)
    const written = JSON.parse(await fs.readText(`${SEARCH_CACHE_DIR}/manifest.json`)) as { notes: BaselineNote[] }
    expect(written.notes.map((item) => item.id)).toEqual(['a', 'b'])
    expect(written.notes.every((item) => item.contentHash === hash)).toBe(true)
  })

  it('seals a shard at 256 and keeps at most 240 records in open.bin for 16-wide batches', async () => {
    const fs = new MemoryFileSystem('shards')
    const cache = await openCache(fs)
    const openPath = `${SEARCH_CACHE_DIR}/vectors/${cache.signature}/shards/open.bin`
    const shardPath = `${SEARCH_CACHE_DIR}/vectors/${cache.signature}/shards/00000001.bin`
    for (let batch = 0; batch < 15; batch += 1) {
      const live: BaselineNote[] = []
      for (let index = 0; index < 16; index += 1) {
        const hash = await hashIndexText(`batch-${batch}-${index}`)
        expect(cache.remember(hash, [batch + 1, index, 0, 1])).toBe(true)
        live.push({ id: `n-${batch}-${index}`, contentHash: hash })
      }
      expect(await cache.flush({ live: cache.liveNotes().concat(live), commit: false })).toBe(true)
    }
    const open = await fs.readBytes(openPath)
    expect(recordCount(open, 4)).toBe(240)
    expect(await fs.stat(shardPath)).toBeNull()

    const last: BaselineNote[] = []
    for (let index = 0; index < 16; index += 1) {
      const hash = await hashIndexText(`batch-15-${index}`)
      expect(cache.remember(hash, [9, index, 0, 1])).toBe(true)
      last.push({ id: `n-15-${index}`, contentHash: hash })
    }
    expect(await cache.flush({ live: [...cache.liveNotes(), ...last], commit: false })).toBe(true)
    expect(recordCount(await fs.readBytes(shardPath), 4)).toBe(VECTOR_SHARD_RECORDS)
    expect(await fs.stat(openPath)).toBeNull()
  })

  it('leaves 241 records unsealed and does not commit a manifest while a hash is missing', async () => {
    const fs = new MemoryFileSystem('gap')
    const cache = await openCache(fs)
    const live: BaselineNote[] = []
    for (let index = 0; index < 241; index += 1) {
      const hash = await hashIndexText(`row-${index}`)
      expect(cache.remember(hash, [1, index, 0, 1])).toBe(true)
      live.push({ id: `row-${index}`, contentHash: hash })
    }
    const missing = await hashIndexText('not-yet')
    live.push({ id: 'missing', contentHash: missing })
    expect(await cache.flush({ live, commit: true, snapshot: vaneSnap() })).toBe(true)
    const openPath = `${SEARCH_CACHE_DIR}/vectors/${cache.signature}/shards/open.bin`
    expect(recordCount(await fs.readBytes(openPath), 4)).toBe(241)
    expect(await fs.stat(`${SEARCH_CACHE_DIR}/manifest.json`)).toBeNull()
    expect(await fs.stat(`${SEARCH_CACHE_DIR}/snapshots/1.vane`)).toBeNull()
    expect(cache.vectorGap).toBe(1)

    expect(cache.remember(missing, [2, 0, 0, 1])).toBe(true)
    const snap = vaneSnap()
    expect(await cache.flush({ live, commit: true, snapshot: snap })).toBe(true)
    expect(cache.vectorGap).toBe(0)
    const manifest = JSON.parse(await fs.readText(`${SEARCH_CACHE_DIR}/manifest.json`)) as {
      notes: BaselineNote[]
      snapshot: { generation: number; bytes: number }
    }
    expect(manifest.notes).toHaveLength(242)
    expect(manifest.notes.some((item) => item.id === 'missing')).toBe(true)
    expect(manifest.snapshot.generation).toBe(1)
    expect(manifest.snapshot.bytes).toBe(snap.byteLength)
    expect(isVaneSnapshot(await fs.readBytes(`${SEARCH_CACHE_DIR}/snapshots/1.vane`))).toBe(true)
    expect(await corpusHash(manifest.notes)).toBe(manifest.snapshot ? (JSON.parse(await fs.readText(`${SEARCH_CACHE_DIR}/manifest.json`)) as { snapshot: { corpusHash: string } }).snapshot.corpusHash : '')
  })

  it('ignores another signature directory', async () => {
    const fs = new MemoryFileSystem('signature')
    const first = await openCache(fs, identity)
    const hash = await hashIndexText('body')
    expect(first.remember(hash, [1, 0, 0, 0])).toBe(true)
    expect(await first.flush({ live: [{ id: 'a', contentHash: hash }], commit: true })).toBe(true)
    const second = await openCache(fs, { ...identity, model: 'other-model' })
    expect(second.signature).not.toBe(first.signature)
    expect(second.baselineNotes()).toBeNull()
    expect(second.haveVector(hash)).toBe(false)
    await second.loadPackIfNeeded([hash])
    expect(second.haveVector(hash)).toBe(false)
  })

  it('restores changed ids with the previous finite vector and holds a missing unchanged record', async () => {
    const previous = '11'.repeat(32)
    const next = '22'.repeat(32)
    const stableMissing = '33'.repeat(32)
    const plan = planSync(
      [note('edited', next, 'new text'), note('gap', stableMissing, 'same text')],
      [{ id: 'edited', contentHash: previous }, { id: 'gap', contentHash: stableMissing }],
      (hash) => hash === next,
      true,
    )
    expect(plan.unchanged).toEqual([])
    expect(plan.cached.map((item) => item.id)).toEqual(['edited'])
    expect(plan.embed.map((item) => item.id)).toEqual(['gap'])
    const vectors = new Map<string, number[]>([
      [previous, [1, 0, 0, 0]],
      [next, [0, 2, 0, 0]],
    ])
    const upserts = hotRestoreUpserts(plan, [
      { id: 'edited', contentHash: previous },
      { id: 'gap', contentHash: stableMissing },
    ], (hash) => vectors.get(hash) ?? null)
    expect(upserts).toEqual([
      { id: 'edited', text: 'new text', vector: [0, 2, 0, 0] },
    ])
  })
})

describe('search cache lock', () => {
  it('leaves a non-empty held directory untouched when rename fails', async () => {
    const fs = new CountingFs('held')
    const cache = await openCache(fs)
    const hash = await hashIndexText('kept')
    expect(cache.remember(hash, [1, 0, 0, 0])).toBe(true)
    expect(await cache.flush({ live: [{ id: 'a', contentHash: hash }], commit: false })).toBe(true)
    const openPath = `${SEARCH_CACHE_DIR}/vectors/${cache.signature}/shards/open.bin`
    const before = await fs.readBytes(openPath)
    const owner = new TextEncoder().encode(JSON.stringify({ v: 1, holder: 'other', acquiredAt: 1_000_000 }))
    await fs.writeBytes(`${SEARCH_CACHE_DIR}/flush-lock/held/owner`, owner)
    await fs.writeBytes(`${SEARCH_CACHE_DIR}/flush-lock/held/marker`, new Uint8Array([7]))
    const extra = await hashIndexText('blocked')
    expect(cache.remember(extra, [0, 1, 0, 0])).toBe(true)
    fs.removed.length = 0
    expect(await cache.flush({
      live: [{ id: 'a', contentHash: hash }, { id: 'b', contentHash: extra }],
      commit: true,
    })).toBe(false)
    expect(new TextDecoder().decode(await fs.readBytes(openPath))).toBe(new TextDecoder().decode(before))
    expect(new TextDecoder().decode(await fs.readBytes(`${SEARCH_CACHE_DIR}/flush-lock/held/owner`))).toBe(new TextDecoder().decode(owner))
    expect(fs.removed.some((path) => path === `${SEARCH_CACHE_DIR}/flush-lock/held` || path.endsWith('/flush-lock/held'))).toBe(false)
    expect(await fs.stat(`${SEARCH_CACHE_DIR}/flush-lock/expired/other`)).toBeNull()
  })

  it('lets the second flush write only after the first holder releases', async () => {
    const fs = new GateFs()
    const waits: Array<() => void> = []
    const options = {
      now: () => 50_000,
      sleep: () => new Promise<void>((resolve) => {
        waits.push(resolve)
      }),
    }
    const first = await SearchDiskCache.open(fs, identity, options)
    const second = await SearchDiskCache.open(fs, identity, options)
    const hashA = await hashIndexText('disk-a')
    const hashB = await hashIndexText('memory-b')
    expect(first.remember(hashA, [1, 0, 0, 0])).toBe(true)
    expect(second.remember(hashB, [0, 1, 0, 0])).toBe(true)
    const flushA = first.flush({ live: [{ id: 'a', contentHash: hashA }], commit: false })
    await waitUntil(async () => !!(await fs.stat(`${SEARCH_CACHE_DIR}/flush-lock/held/owner`)))
    const flushB = second.flush({ live: [{ id: 'b', contentHash: hashB }], commit: false })
    await waitUntil(() => waits.length > 0)
    fs.releaseBlock()
    expect(await flushA).toBe(true)
    waits.shift()?.()
    expect(await flushB).toBe(true)
    const merged = await openCache(fs)
    expect(merged.haveVector(hashA)).toBe(true)
    expect(merged.haveVector(hashB)).toBe(true)
  })

  it('merges a disk hash with a different in-memory hash', async () => {
    const fs = new MemoryFileSystem('merge')
    const cache = await openCache(fs)
    const hashA = await hashIndexText('hash-a')
    expect(cache.remember(hashA, [4, 0, 0, 1])).toBe(true)
    expect(await cache.flush({ live: [{ id: 'a', contentHash: hashA }], commit: false })).toBe(true)
    const hashB = await hashIndexText('hash-b')
    expect(cache.remember(hashB, [0, 5, 0, 1])).toBe(true)
    expect(await cache.flush({
      live: [{ id: 'a', contentHash: hashA }, { id: 'b', contentHash: hashB }],
      commit: false,
    })).toBe(true)
    const again = await openCache(fs)
    expect(again.vector(hashA)).toEqual([4, 0, 0, 1])
    expect(again.vector(hashB)).toEqual([0, 5, 0, 1])
  })

  it('moves a held lock older than 120s and leaves a fresh one in place', async () => {
    const staleFs = new MemoryFileSystem('stale')
    let now = 5_000_000
    const stale = await SearchDiskCache.open(staleFs, identity, { now: () => now, sleep: async () => undefined })
    const hash = await hashIndexText('after-steal')
    const owner = new TextEncoder().encode(JSON.stringify({ v: 1, holder: 'old-holder', acquiredAt: now - 120_001 }))
    await staleFs.writeBytes(`${SEARCH_CACHE_DIR}/flush-lock/held/owner`, owner)
    await staleFs.writeBytes(`${SEARCH_CACHE_DIR}/flush-lock/held/marker`, new Uint8Array([1]))
    expect(stale.remember(hash, [1, 2, 3, 4])).toBe(true)
    expect(await stale.flush({ live: [{ id: 'a', contentHash: hash }], commit: false })).toBe(true)
    expect((await staleFs.stat(`${SEARCH_CACHE_DIR}/flush-lock/expired/old-holder`))?.kind).toBe('directory')
    expect(await staleFs.stat(`${SEARCH_CACHE_DIR}/flush-lock/held`)).toBeNull()
    expect((await openCache(staleFs)).haveVector(hash)).toBe(true)

    const freshFs = new MemoryFileSystem('fresh')
    now = 8_000_000
    const fresh = await SearchDiskCache.open(freshFs, identity, { now: () => now, sleep: async () => undefined })
    const kept = await hashIndexText('already')
    expect(fresh.remember(kept, [1, 0, 0, 0])).toBe(true)
    expect(await fresh.flush({ live: [{ id: 'a', contentHash: kept }], commit: false })).toBe(true)
    const openPath = `${SEARCH_CACHE_DIR}/vectors/${fresh.signature}/shards/open.bin`
    const before = await freshFs.readBytes(openPath)
    const freshOwner = new TextEncoder().encode(JSON.stringify({ v: 1, holder: 'fresh-holder', acquiredAt: now - 120_000 }))
    await freshFs.writeBytes(`${SEARCH_CACHE_DIR}/flush-lock/held/owner`, freshOwner)
    await freshFs.writeBytes(`${SEARCH_CACHE_DIR}/flush-lock/held/marker`, new Uint8Array([2]))
    const extra = await hashIndexText('nope')
    expect(fresh.remember(extra, [0, 1, 0, 0])).toBe(true)
    expect(await fresh.flush({ live: [{ id: 'a', contentHash: kept }, { id: 'b', contentHash: extra }], commit: false })).toBe(false)
    expect(new TextDecoder().decode(await freshFs.readBytes(openPath))).toBe(new TextDecoder().decode(before))
    expect(new TextDecoder().decode(await freshFs.readBytes(`${SEARCH_CACHE_DIR}/flush-lock/held/owner`))).toBe(new TextDecoder().decode(freshOwner))
    expect(await freshFs.stat(`${SEARCH_CACHE_DIR}/flush-lock/expired/fresh-holder`)).toBeNull()
  })
})

describe('search cache hashing', () => {
  it('hashes a thousand and ten thousand short texts inside the budget', async () => {
    const one = Array.from({ length: 1000 }, (_, index) => `n${index}${'x'.repeat(2048)}`)
    const started = performance.now()
    const first = await hashIndexTexts(one)
    const elapsed1k = performance.now() - started
    expect(first).toHaveLength(1000)
    expect(first[0]).toMatch(/^[0-9a-f]{64}$/)
    expect(elapsed1k).toBeLessThan(500)
    const ten = Array.from({ length: 10_000 }, (_, index) => `m${index}${'y'.repeat(2048)}`)
    const started10 = performance.now()
    const second = await hashIndexTexts(ten)
    const elapsed10k = performance.now() - started10
    expect(second).toHaveLength(10_000)
    expect(elapsed10k).toBeLessThan(2000)
    expect(await hashIndexText('Title\nbody')).toBe(first.length > 0 ? await hashIndexText('Title\nbody') : '')
  })
})
