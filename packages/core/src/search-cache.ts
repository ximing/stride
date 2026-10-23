import { PlatformError, type FileSystemBackend } from '@stride/platform'
import { plainText, type StrideNote } from './note.ts'
import { sha256HexSync } from './sha256.ts'

export const INDEX_TEXT_ALGO = 1 as const
export const SEARCH_CACHE_FORMAT = 1 as const
export const SEARCH_CACHE_DIR = '.stride/search/v1'
export const VECTOR_SHARD_RECORDS = 256
export const FLUSH_LOCK_HEARTBEAT_MS = 10_000
export const FLUSH_LOCK_STALE_MS = 120_000
export const FLUSH_LOCK_BACKOFF_MS = [200, 400, 800, 1600, 3200] as const
export const SNAPSHOT_FLUSH_MS = 5000
export const QUERY_VECTOR_CACHE = 32
export const HASH_BATCH = 200

const SEMB_MAGIC = 'SEMB'
const SEMB_HEADER = 16
const HASH_BYTES = 32
const CRC_BYTES = 4

// Captured before tests install fake timers. Heartbeats must not chain under runAllTimersAsync.
const nativeSetTimeout = globalThis.setTimeout.bind(globalThis)
const nativeClearTimeout = globalThis.clearTimeout.bind(globalThis)

export interface EmbeddingIdentity {
  endpoint: string
  model: string
  dim: number
}

export interface SearchCacheOptions {
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  /** Skip a second SHA-256 when the caller already hashed this identity. */
  signature?: string
}

export interface CacheNote {
  id: string
  text: string
  contentHash: string
}

export interface BaselineNote {
  id: string
  contentHash: string
}

export interface SyncPlan {
  restoreSnapshot: boolean
  snapshotGeneration: number | null
  remove: string[]
  unchanged: string[]
  cached: CacheNote[]
  embed: CacheNote[]
}

export interface SearchCacheManifest {
  format: 1
  textAlgo: 1
  embedding: {
    signature: string
    model: string
    dim: number
    previousSignature?: string
  }
  notes: BaselineNote[]
  snapshot: {
    generation: number
    corpusHash: string
    bytes: number
    dim: number
  } | null
}

export interface VectorRecord {
  hash: Uint8Array
  vector: Float32Array
}

export interface FlushRequest {
  live: readonly BaselineNote[]
  commit: boolean
  snapshot?: Uint8Array | null
}

interface Clock {
  now: () => number
  sleep: (ms: number) => Promise<void>
}

const defaultClock: Clock = {
  now: () => Date.now(),
  sleep: (ms: number) => new Promise((resolve) => {
    nativeSetTimeout(resolve, ms)
  }),
}

export function indexText(note: StrideNote): string {
  return `${note.title}\n${plainText(note.doc)}`
}

export function canonicalEmbeddingEndpoint(endpoint: string): string {
  const trimmed = endpoint.trim().replace(/\/+$/, '')
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return trimmed
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return trimmed
  url.username = ''
  url.password = ''
  url.search = ''
  url.hash = ''
  if ((url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80')) {
    url.port = ''
  }
  let path = url.pathname.replace(/\/+$/, '')
  if (path === '/') path = ''
  return `${url.protocol}//${url.host}${path}`
}

export async function embeddingSignature(identity: EmbeddingIdentity): Promise<string> {
  const endpoint = canonicalEmbeddingEndpoint(identity.endpoint)
  const model = identity.model.trim()
  const text = `v1\n${INDEX_TEXT_ALGO}\n${endpoint}\n${model}\n${identity.dim}\n`
  return sha256Hex(new TextEncoder().encode(text))
}

export async function hashIndexText(text: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(text))
}

export async function hashIndexTexts(texts: readonly string[]): Promise<string[]> {
  const out: string[] = []
  for (let offset = 0; offset < texts.length; offset += HASH_BATCH) {
    if (offset > 0) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0)
      })
    }
    const slice = texts.slice(offset, offset + HASH_BATCH)
    const hashed = await Promise.all(slice.map((text) => hashIndexText(text)))
    out.push(...hashed)
  }
  return out
}

export async function corpusHash(notes: readonly BaselineNote[]): Promise<string> {
  const rows = [...notes].sort(compareNotes)
  let text = ''
  for (const row of rows) text += `${row.id}\t${row.contentHash}\n`
  return sha256Hex(new TextEncoder().encode(text))
}

export function planSync(
  current: readonly CacheNote[],
  baseline: readonly BaselineNote[] | null,
  haveVector: (hash: string) => boolean,
  snapshotValid: boolean,
): SyncPlan {
  const usable = snapshotValid && baseline !== null
  const base = new Map<string, string>()
  if (usable && baseline) {
    for (const note of baseline) base.set(note.id, note.contentHash)
  }
  const remove: string[] = []
  const unchanged: string[] = []
  const cached: CacheNote[] = []
  const embed: CacheNote[] = []
  const seen = new Set<string>()
  for (const note of current) {
    seen.add(note.id)
    const present = haveVector(note.contentHash)
    if (usable && base.get(note.id) === note.contentHash) {
      if (present) unchanged.push(note.id)
      else embed.push(note)
      continue
    }
    if (present) cached.push(note)
    else embed.push(note)
  }
  if (usable && baseline) {
    for (const note of baseline) {
      if (!seen.has(note.id)) remove.push(note.id)
    }
  }
  remove.sort(compareId)
  unchanged.sort(compareId)
  return {
    restoreSnapshot: usable,
    snapshotGeneration: null,
    remove,
    unchanged,
    cached,
    embed,
  }
}

export function docsForRebuild(
  restored: boolean,
  plan: SyncPlan,
  notes: readonly CacheNote[],
  vectorOf: (hash: string) => number[] | null,
  baseline: readonly BaselineNote[] | null,
): { id: string; text: string; vector?: number[] }[] {
  if (!restored || !plan.restoreSnapshot) {
    return notes.map((note) => {
      const vector = finiteVector(vectorOf(note.contentHash))
      return vector ? { id: note.id, text: note.text, vector } : { id: note.id, text: note.text }
    })
  }
  return hotRestoreUpserts(plan, baseline, vectorOf)
}

export function hotRestoreUpserts(
  plan: SyncPlan,
  baseline: readonly BaselineNote[] | null,
  vectorOf: (hash: string) => number[] | null,
): { id: string; text: string; vector?: number[] }[] {
  const previous = new Map<string, string>()
  if (baseline) {
    for (const note of baseline) previous.set(note.id, note.contentHash)
  }
  const upserts: { id: string; text: string; vector?: number[] }[] = []
  for (const note of plan.cached) {
    const vector = finiteVector(vectorOf(note.contentHash))
    upserts.push(vector ? { id: note.id, text: note.text, vector } : { id: note.id, text: note.text })
  }
  for (const note of plan.embed) {
    const prev = previous.get(note.id)
    if (prev && prev === note.contentHash) continue
    if (prev && prev !== note.contentHash) {
      const old = finiteVector(vectorOf(prev))
      if (old && !isAllZero(old)) {
        upserts.push({ id: note.id, text: note.text, vector: old })
        continue
      }
    }
    upserts.push({ id: note.id, text: note.text })
  }
  return upserts
}

export function isExistsConflict(error: unknown): boolean {
  if (error instanceof PlatformError && error.code === 'already-exists') return true
  const text = error instanceof Error ? error.message : String(error)
  return /\bos error 183\b/.test(text)
    || /ERROR_ALREADY_EXISTS/i.test(text)
    || /\balready exists\b/i.test(text)
}

// The backend replaces an existing file. Deleting it here first drops the live bytes when the second rename fails.
export async function atomicWrite(fs: FileSystemBackend, path: string, bytes: Uint8Array): Promise<void> {
  const tmp = `${path}.tmp`
  await fs.writeBytes(tmp, bytes)
  await fs.rename(tmp, path)
}

export async function readValidFile(
  fs: FileSystemBackend,
  path: string,
  validate: (bytes: Uint8Array) => boolean,
): Promise<Uint8Array | null> {
  const finalStat = await fs.stat(path).catch(() => null)
  if (finalStat?.kind === 'file') {
    try {
      const bytes = await fs.readBytes(path)
      if (validate(bytes)) return bytes
    } catch {
      // Try the sibling tmp below.
    }
  }
  const tmp = `${path}.tmp`
  const tmpStat = await fs.stat(tmp).catch(() => null)
  if (tmpStat?.kind !== 'file') return null
  try {
    const bytes = await fs.readBytes(tmp)
    if (!validate(bytes)) return null
    try {
      await fs.rename(tmp, path)
    } catch {
      // The bytes are still usable when promotion loses a race.
    }
    return bytes
  } catch {
    return null
  }
}

export function encodeVectorBlob(dim: number, records: readonly VectorRecord[]): Uint8Array {
  if (!Number.isInteger(dim) || dim < 0) throw new Error('Invalid vector dim')
  const recordSize = HASH_BYTES + dim * 4 + CRC_BYTES
  const bytes = new Uint8Array(SEMB_HEADER + records.length * recordSize)
  const view = new DataView(bytes.buffer)
  bytes.set(encoder.encode(SEMB_MAGIC), 0)
  view.setUint32(4, 1, true)
  view.setUint32(8, dim, true)
  view.setUint32(12, 0, true)
  let offset = SEMB_HEADER
  for (const record of records) {
    if (record.hash.byteLength !== HASH_BYTES) throw new Error('Vector hash must be 32 bytes')
    if (record.vector.length !== dim) throw new Error('Vector dim does not match the blob')
    bytes.set(record.hash, offset)
    for (let index = 0; index < dim; index += 1) {
      view.setFloat32(offset + HASH_BYTES + index * 4, record.vector[index] ?? Number.NaN, true)
    }
    const crc = crc32(bytes.subarray(offset, offset + HASH_BYTES + dim * 4))
    view.setUint32(offset + HASH_BYTES + dim * 4, crc, true)
    offset += recordSize
  }
  return bytes
}

export function parseVectorBlob(bytes: Uint8Array, expectedDim: number): VectorRecord[] {
  if (!sembHeaderOk(bytes, expectedDim)) return []
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const recordSize = HASH_BYTES + expectedDim * 4 + CRC_BYTES
  const found: VectorRecord[] = []
  let offset = SEMB_HEADER
  while (offset + recordSize <= bytes.byteLength) {
    const bodyEnd = offset + HASH_BYTES + expectedDim * 4
    const actual = view.getUint32(bodyEnd, true)
    if (crc32(bytes.subarray(offset, bodyEnd)) === actual) {
      const vector = new Float32Array(expectedDim)
      let finite = true
      for (let index = 0; index < expectedDim; index += 1) {
        const value = view.getFloat32(offset + HASH_BYTES + index * 4, true)
        vector[index] = value
        if (!Number.isFinite(value)) finite = false
      }
      if (finite) found.push({ hash: bytes.slice(offset, offset + HASH_BYTES), vector })
    }
    offset += recordSize
  }
  return found
}

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff
  for (let index = 0; index < data.byteLength; index += 1) {
    crc ^= data[index]!
    for (let bit = 0; bit < 8; bit += 1) {
      const mask = -(crc & 1)
      crc = (crc >>> 1) ^ (0xedb88320 & mask)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

export function isVaneSnapshot(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 13) return false
  if (decoder.decode(bytes.subarray(0, 9)) !== 'VANE_SNAP') return false
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return view.getUint32(9, true) === 1
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function compareId(left: string, right: string): number {
  const a = encoder.encode(left)
  const b = encoder.encode(right)
  const length = Math.min(a.byteLength, b.byteLength)
  for (let index = 0; index < length; index += 1) {
    if (a[index] !== b[index]) return a[index]! - b[index]!
  }
  return a.byteLength - b.byteLength
}

function compareNotes(left: BaselineNote, right: BaselineNote): number {
  return compareId(left.id, right.id)
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  return sha256HexSync(data)
}

function hexToBytes(hex: string): Uint8Array | null {
  if (!/^[0-9a-f]{64}$/.test(hex)) return null
  const out = new Uint8Array(HASH_BYTES)
  for (let index = 0; index < HASH_BYTES; index += 1) {
    out[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
  }
  return out
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = ''
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0')
  return hex
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}

function isAllZero(values: ArrayLike<number>): boolean {
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] !== 0) return false
  }
  return true
}

function finiteVector(vector: number[] | null): number[] | null {
  if (!vector || vector.length === 0) return null
  for (const value of vector) {
    if (!Number.isFinite(value)) return null
  }
  return vector
}

function sembHeaderOk(bytes: Uint8Array, expectedDim: number): boolean {
  if (bytes.byteLength < SEMB_HEADER) return false
  if (decoder.decode(bytes.subarray(0, 4)) !== SEMB_MAGIC) return false
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return view.getUint32(4, true) === 1 && view.getUint32(8, true) === expectedDim
}

function recordOf(dim: number, hash: Uint8Array, values: ArrayLike<number>): Uint8Array {
  const vector = new Float32Array(dim)
  for (let index = 0; index < dim; index += 1) vector[index] = values[index] ?? 0
  return encodeVectorBlob(dim, [{ hash, vector }]).slice(SEMB_HEADER)
}

function blobFromRaw(dim: number, hashes: readonly string[], records: Map<string, Uint8Array>): Uint8Array {
  const recordSize = HASH_BYTES + dim * 4 + CRC_BYTES
  const bytes = new Uint8Array(SEMB_HEADER + hashes.length * recordSize)
  const view = new DataView(bytes.buffer)
  bytes.set(encoder.encode(SEMB_MAGIC), 0)
  view.setUint32(4, 1, true)
  view.setUint32(8, dim, true)
  view.setUint32(12, 0, true)
  let offset = SEMB_HEADER
  for (const hash of hashes) {
    const record = records.get(hash)
    if (!record || record.byteLength !== recordSize) throw new Error('SEMB record length does not match dim')
    bytes.set(record, offset)
    offset += recordSize
  }
  return bytes
}

function vectorFromRecord(record: Uint8Array, dim: number): number[] | null {
  if (record.byteLength !== HASH_BYTES + dim * 4 + CRC_BYTES) return null
  const wrapped = new Uint8Array(SEMB_HEADER + record.byteLength)
  const view = new DataView(wrapped.buffer)
  wrapped.set(encoder.encode(SEMB_MAGIC), 0)
  view.setUint32(4, 1, true)
  view.setUint32(8, dim, true)
  view.setUint32(12, 0, true)
  wrapped.set(record, SEMB_HEADER)
  const records = parseVectorBlob(wrapped, dim)
  const found = records[0]
  if (!found) return null
  return Array.from(found.vector)
}

function newHolder(): string {
  const randomUUID = globalThis.crypto?.randomUUID
  if (typeof randomUUID === 'function') return randomUUID.call(globalThis.crypto)
  const bytes = new Uint8Array(16)
  globalThis.crypto.getRandomValues(bytes)
  return bytesToHex(bytes)
}

interface OwnerFile {
  v: 1
  holder: string
  acquiredAt: number
}

function encodeOwner(holder: string, acquiredAt: number): Uint8Array {
  return encoder.encode(JSON.stringify({ v: 1, holder, acquiredAt }))
}

function decodeOwner(bytes: Uint8Array): OwnerFile | null {
  try {
    const parsed = JSON.parse(decoder.decode(bytes)) as Partial<OwnerFile>
    if (parsed.v !== 1 || typeof parsed.holder !== 'string' || typeof parsed.acquiredAt !== 'number') return null
    if (!Number.isFinite(parsed.acquiredAt)) return null
    return { v: 1, holder: parsed.holder, acquiredAt: parsed.acquiredAt }
  } catch {
    return null
  }
}

export class SearchDiskCache {
  readonly signature: string
  readonly dim: number
  vectorGap = 0
  private readonly fs: FileSystemBackend
  private readonly model: string
  private readonly clock: Clock
  private readonly shardMap = new Map<string, Uint8Array>()
  private packMap: Map<string, Uint8Array> | null = null
  private packLoaded = false
  private readonly pending = new Map<string, Uint8Array>()
  private readonly noteHashes = new Map<string, string>()
  private baseline: BaselineNote[] | null = null
  private manifest: SearchCacheManifest | null = null
  private tail: Promise<void> = Promise.resolve()
  private heartbeat: ReturnType<typeof setTimeout> | null = null
  private heartbeatGen = 0

  private constructor(fs: FileSystemBackend, identity: EmbeddingIdentity, signature: string, options?: SearchCacheOptions) {
    this.fs = fs
    this.signature = signature
    this.dim = identity.dim
    this.model = identity.model.trim()
    this.clock = {
      now: options?.now ?? defaultClock.now,
      sleep: options?.sleep ?? defaultClock.sleep,
    }
  }

  static async open(
    fs: FileSystemBackend,
    identity: EmbeddingIdentity,
    options?: SearchCacheOptions,
  ): Promise<SearchDiskCache> {
    const signature = options?.signature ?? await embeddingSignature(identity)
    const cache = new SearchDiskCache(fs, identity, signature, options)
    await cache.load()
    return cache
  }

  haveVector(hash: string): boolean {
    if (this.shardMap.has(hash)) return true
    return this.packLoaded && (this.packMap?.has(hash) ?? false)
  }

  vector(hash: string): number[] | null {
    const packed = this.packLoaded ? this.packMap?.get(hash) : undefined
    const record = packed ?? this.shardMap.get(hash)
    if (!record || this.dim <= 0) return null
    return vectorFromRecord(record, this.dim)
  }

  baselineNotes(): BaselineNote[] | null {
    return this.baseline ? this.baseline.map((note) => ({ ...note })) : null
  }

  noteHash(id: string): string | undefined {
    return this.noteHashes.get(id)
  }

  setNote(id: string, contentHash: string): void {
    this.noteHashes.set(id, contentHash)
  }

  removeNote(id: string): void {
    this.noteHashes.delete(id)
  }

  liveNotes(): BaselineNote[] {
    const notes: BaselineNote[] = []
    for (const [id, contentHash] of this.noteHashes) notes.push({ id, contentHash })
    notes.sort(compareNotes)
    return notes
  }

  /** Real API zeros pass `allowZero`. Placeholder zeros never enter SEMB. */
  remember(contentHash: string, values: ArrayLike<number>, allowZero = false): boolean {
    if (this.dim <= 0) return false
    const hash = hexToBytes(contentHash)
    if (!hash || values.length !== this.dim) return false
    for (let index = 0; index < values.length; index += 1) {
      if (!Number.isFinite(values[index]!)) return false
    }
    if (!allowZero && isAllZero(values)) return false
    const record = recordOf(this.dim, hash, values)
    this.pending.set(contentHash, record)
    this.shardMap.set(contentHash, record)
    return true
  }

  recompute(notes: readonly { contentHash: string }[]): number {
    if (this.dim <= 0) {
      this.vectorGap = 0
      return 0
    }
    let gap = 0
    for (const note of notes) {
      if (!this.haveVector(note.contentHash)) gap += 1
    }
    this.vectorGap = gap
    return gap
  }

  plan(current: readonly CacheNote[], snapshotValid: boolean): SyncPlan {
    const plan = planSync(current, this.baseline, (hash) => this.haveVector(hash), snapshotValid)
    if (plan.restoreSnapshot) plan.snapshotGeneration = this.manifest?.snapshot?.generation ?? null
    this.recompute(current)
    return plan
  }

  async loadPackIfNeeded(hashes: readonly string[]): Promise<void> {
    if (this.packLoaded || this.dim <= 0) return
    for (const hash of hashes) {
      if (!this.shardMap.has(hash)) {
        await this.readPack()
        return
      }
    }
  }

  dropPackMap(): void {
    this.packMap = null
    this.packLoaded = false
  }

  async snapshotUsable(openDim: number): Promise<boolean> {
    const snapshot = this.manifest?.snapshot
    if (!snapshot || !this.baseline || this.manifest?.embedding.signature !== this.signature) return false
    if (snapshot.dim !== openDim) return false
    if (snapshot.corpusHash !== await corpusHash(this.baseline)) return false
    if (!/^[0-9]+$/.test(String(snapshot.generation))) return false
    const path = snapshotFile(snapshot.generation)
    const stat = await this.fs.stat(path).catch(() => null)
    if (!stat || stat.kind !== 'file' || stat.size !== snapshot.bytes) return false
    try {
      const bytes = await this.fs.readBytes(path)
      return bytes.byteLength === snapshot.bytes && isVaneSnapshot(bytes)
    } catch {
      return false
    }
  }

  async readSnapshot(): Promise<Uint8Array | null> {
    const generation = this.manifest?.snapshot?.generation
    if (!generation) return null
    const bytes = await readValidFile(this.fs, snapshotFile(generation), isVaneSnapshot)
    return bytes
  }

  flush(request: FlushRequest): Promise<boolean> {
    const run = this.tail.then(() => this.flushBody(request), () => this.flushBody(request))
    this.tail = run.then(() => undefined, () => undefined)
    return run
  }

  private async load(): Promise<void> {
    this.manifest = await this.readManifest()
    if (this.manifest?.embedding.signature === this.signature) {
      this.baseline = this.manifest.notes.map((note) => ({ id: note.id, contentHash: note.contentHash }))
    } else {
      this.baseline = null
    }
    if (this.dim > 0) await this.scanShardsInto(this.shardMap)
  }

  private async flushBody(request: FlushRequest): Promise<boolean> {
    const holder = await this.acquireLock()
    if (!holder) return false
    this.startHeartbeat(holder)
    try {
      const live = [...request.live].sort(compareNotes)
      for (const note of live) this.noteHashes.set(note.id, note.contentHash)
      if (!(await this.stillHeld(holder))) return false
      const disk = await this.rereadDisk()
      const merged = new Map<string, Uint8Array>(disk.pack)
      for (const [hash, record] of disk.sealed) if (!merged.has(hash)) merged.set(hash, record)
      for (const [hash, record] of disk.open) if (!merged.has(hash)) merged.set(hash, record)
      for (const [hash, record] of this.pending) {
        const existing = merged.get(hash)
        if (!existing) merged.set(hash, record)
        else if (!sameBytes(existing, record)) this.pending.delete(hash)
      }
      const missing = this.dim > 0 ? live.filter((note) => !merged.has(note.contentHash)) : []
      this.vectorGap = missing.length
      const commit = request.commit && missing.length === 0
      if (!(await this.stillHeld(holder))) return false
      if (!commit) {
        const wrote = await this.writeRemainder(holder, disk, merged)
        if (!wrote) return false
        if (this.dim > 0) {
          await this.scanShardsInto(this.shardMap)
          this.packMap = disk.pack
          this.packLoaded = true
        }
        this.pending.clear()
        return true
      }
      if (this.dim > 0) {
        const referenced = new Map<string, Uint8Array>()
        for (const note of live) {
          const record = merged.get(note.contentHash)
          if (record) referenced.set(note.contentHash, record)
        }
        const records: VectorRecord[] = []
        for (const hash of [...referenced.keys()].sort()) {
          const raw = referenced.get(hash)
          const decoded = raw ? vectorFromRecord(raw, this.dim) : null
          const bytes = hexToBytes(hash)
          if (!raw || !decoded || !bytes) continue
          records.push({ hash: bytes, vector: Float32Array.from(decoded) })
        }
        if (!(await this.stillHeld(holder))) return false
        await atomicWrite(this.fs, this.packPath(), encodeVectorBlob(this.dim, records))
        for (const name of disk.shardNames) {
          if (!(await this.stillHeld(holder))) return false
          await this.fs.remove(`${this.shardDir()}/${name}`).catch(() => undefined)
        }
        if (await this.fs.stat(this.openPath())) {
          if (!(await this.stillHeld(holder))) return false
          await this.fs.remove(this.openPath()).catch(() => undefined)
        }
      }
      let snapshotMeta: SearchCacheManifest['snapshot'] = null
      if (request.snapshot && request.snapshot.byteLength > 0 && isVaneSnapshot(request.snapshot)) {
        const generation = (this.manifest?.snapshot?.generation ?? 0) + 1
        if (!(await this.stillHeld(holder))) return false
        await atomicWrite(this.fs, snapshotFile(generation), request.snapshot)
        snapshotMeta = {
          generation,
          corpusHash: await corpusHash(live),
          bytes: request.snapshot.byteLength,
          dim: this.dim,
        }
      }
      const covered = this.dim > 0 ? live.filter((note) => merged.has(note.contentHash)) : live
      const notes = [...covered].sort(compareNotes)
      const previous = this.previousSignature()
      const manifest: SearchCacheManifest = {
        format: SEARCH_CACHE_FORMAT,
        textAlgo: INDEX_TEXT_ALGO,
        embedding: {
          signature: this.signature,
          model: this.model,
          dim: this.dim,
          ...(previous ? { previousSignature: previous } : {}),
        },
        notes,
        snapshot: snapshotMeta,
      }
      if (!(await this.stillHeld(holder))) return false
      await atomicWrite(this.fs, manifestPath(), encoder.encode(`${JSON.stringify(manifest)}\n`))
      this.manifest = manifest
      this.baseline = notes.map((note) => ({ ...note }))
      this.noteHashes.clear()
      for (const note of notes) this.noteHashes.set(note.id, note.contentHash)
      if (snapshotMeta) await this.deleteOtherSnapshots(snapshotMeta.generation)
      await this.deleteOtherSignatures(previous)
      this.pending.clear()
      if (this.dim > 0) {
        this.shardMap.clear()
        await this.readPack()
      }
      this.vectorGap = 0
      return true
    } finally {
      await this.release(holder)
    }
  }

  private previousSignature(): string | undefined {
    const embedding = this.manifest?.embedding
    if (!embedding) return undefined
    if (embedding.signature !== this.signature) return embedding.signature
    return embedding.previousSignature
  }

  private async writeRemainder(
    holder: string,
    disk: DiskRecords,
    merged: Map<string, Uint8Array>,
  ): Promise<boolean> {
    if (this.dim <= 0) return true
    const remainder = new Map<string, Uint8Array>()
    for (const [hash, record] of disk.open) {
      if (disk.sealed.has(hash) || disk.pack.has(hash)) continue
      remainder.set(hash, record)
    }
    for (const [hash, record] of this.pending) {
      if (disk.sealed.has(hash) || disk.pack.has(hash)) continue
      const existing = remainder.get(hash) ?? merged.get(hash)
      if (existing && !sameBytes(existing, record) && (disk.open.has(hash) || disk.sealed.has(hash) || disk.pack.has(hash))) {
        continue
      }
      remainder.set(hash, existing && disk.open.has(hash) ? existing : record)
    }
    let next = disk.nextShard
    const hashes = [...remainder.keys()].sort()
    let cursor = 0
    while (hashes.length - cursor >= VECTOR_SHARD_RECORDS) {
      const slice = hashes.slice(cursor, cursor + VECTOR_SHARD_RECORDS)
      cursor += VECTOR_SHARD_RECORDS
      if (!(await this.stillHeld(holder))) return false
      await atomicWrite(this.fs, `${this.shardDir()}/${shardName(next)}`, blobFromRaw(this.dim, slice, remainder))
      for (const hash of slice) remainder.delete(hash)
      next += 1
    }
    if (!(await this.stillHeld(holder))) return false
    if (remainder.size === 0) {
      if (await this.fs.stat(this.openPath())) await this.fs.remove(this.openPath())
      return true
    }
    await atomicWrite(this.fs, this.openPath(), blobFromRaw(this.dim, [...remainder.keys()].sort(), remainder))
    return true
  }

  private async rereadDisk(): Promise<DiskRecords> {
    const sealed = new Map<string, Uint8Array>()
    const open = new Map<string, Uint8Array>()
    const names = await this.shardFiles()
    let nextShard = 1
    for (const name of names) {
      const parsed = Number.parseInt(name.slice(0, 8), 10)
      if (Number.isFinite(parsed) && parsed >= nextShard) nextShard = parsed + 1
      const bytes = await readValidFile(this.fs, `${this.shardDir()}/${name}`, (value) => sembHeaderOk(value, this.dim))
      if (!bytes) continue
      this.addRecords(sealed, parseVectorBlob(bytes, this.dim))
    }
    const openBytes = await readValidFile(this.fs, this.openPath(), (value) => sembHeaderOk(value, this.dim))
    if (openBytes) this.addRecords(open, parseVectorBlob(openBytes, this.dim))
    const pack = new Map<string, Uint8Array>()
    const packBytes = await readValidFile(this.fs, this.packPath(), (value) => sembHeaderOk(value, this.dim))
    if (packBytes) this.addRecords(pack, parseVectorBlob(packBytes, this.dim))
    return { sealed, open, pack, shardNames: names, nextShard }
  }

  private addRecords(target: Map<string, Uint8Array>, records: readonly VectorRecord[]): void {
    for (const record of records) {
      target.set(bytesToHex(record.hash), recordOf(this.dim, record.hash, record.vector))
    }
  }

  private async scanShardsInto(target: Map<string, Uint8Array>): Promise<void> {
    target.clear()
    const names = await this.shardFiles()
    for (const name of names) {
      const bytes = await readValidFile(this.fs, `${this.shardDir()}/${name}`, (value) => sembHeaderOk(value, this.dim))
      if (!bytes) continue
      this.addRecords(target, parseVectorBlob(bytes, this.dim))
    }
    const openBytes = await readValidFile(this.fs, this.openPath(), (value) => sembHeaderOk(value, this.dim))
    if (openBytes) this.addRecords(target, parseVectorBlob(openBytes, this.dim))
  }

  private async readPack(): Promise<void> {
    const pack = new Map<string, Uint8Array>()
    if (this.dim > 0) {
      const bytes = await readValidFile(this.fs, this.packPath(), (value) => sembHeaderOk(value, this.dim))
      if (bytes) this.addRecords(pack, parseVectorBlob(bytes, this.dim))
    }
    this.packMap = pack
    this.packLoaded = true
  }

  private async readManifest(): Promise<SearchCacheManifest | null> {
    const bytes = await readValidFile(this.fs, manifestPath(), (value) => parseManifest(value) !== null)
    if (!bytes) return null
    return parseManifest(bytes)
  }

  private async shardFiles(): Promise<string[]> {
    const entries = await this.listOrEmpty(this.shardDir())
    return entries
      .filter((entry) => entry.kind === 'file' && /^[0-9]{8}\.bin$/.test(entry.name))
      .map((entry) => entry.name)
      .sort()
  }

  private async listOrEmpty(path: string): Promise<{ name: string; kind: 'file' | 'directory' }[]> {
    const stat = await this.fs.stat(path).catch(() => null)
    if (!stat || stat.kind !== 'directory') return []
    return this.fs.list(path)
  }

  private async acquireLock(): Promise<string | null> {
    for (let attempt = 0; attempt <= FLUSH_LOCK_BACKOFF_MS.length; attempt += 1) {
      const holder = await this.tryAcquireOnce(true)
      if (holder) return holder
      if (attempt === FLUSH_LOCK_BACKOFF_MS.length) return null
      await this.clock.sleep(FLUSH_LOCK_BACKOFF_MS[attempt]!)
    }
    return null
  }

  // held/ is a directory. A non-empty destination must stay; rename fails instead of replacing it.
  private async tryAcquireOnce(allowSteal: boolean): Promise<string | null> {
    const holder = newHolder()
    const claim = `${lockDir()}/claims/${holder}`
    await this.writeOwner(`${claim}/owner`, holder, this.clock.now())
    const held = `${lockDir()}/held`
    try {
      await this.fs.rename(claim, held)
    } catch {
      if (await this.fs.stat(claim).catch(() => null)) await this.fs.remove(claim).catch(() => undefined)
      const occupied = await this.fs.stat(held).catch(() => null)
      if (!occupied || !allowSteal) return null
      const owner = await this.readOwner(`${held}/owner`)
      if (!owner || this.clock.now() - owner.acquiredAt <= FLUSH_LOCK_STALE_MS) return null
      const expired = `${lockDir()}/expired/${owner.holder}`
      try {
        if (await this.fs.stat(expired).catch(() => null)) await this.fs.remove(expired)
        await this.fs.rename(held, expired)
      } catch {
        return null
      }
      return this.tryAcquireOnce(false)
    }
    const owner = await this.readOwner(`${held}/owner`)
    if (!owner || owner.holder !== holder) return null
    return holder
  }

  private startHeartbeat(holder: string): void {
    const generation = ++this.heartbeatGen
    const arm = () => {
      this.heartbeat = nativeSetTimeout(() => {
        void this.beat(holder, generation, arm)
      }, FLUSH_LOCK_HEARTBEAT_MS)
    }
    arm()
  }

  private async beat(holder: string, generation: number, arm: () => void): Promise<void> {
    if (generation !== this.heartbeatGen) return
    const owner = await this.readOwner(`${lockDir()}/held/owner`)
    if (!owner || owner.holder !== holder || generation !== this.heartbeatGen) return
    try {
      await this.writeOwner(`${lockDir()}/held/owner`, holder, this.clock.now())
    } catch {
      return
    }
    if (generation !== this.heartbeatGen) return
    arm()
  }

  private stopHeartbeat(): void {
    this.heartbeatGen += 1
    if (this.heartbeat) nativeClearTimeout(this.heartbeat)
    this.heartbeat = null
  }

  private async stillHeld(holder: string): Promise<boolean> {
    const owner = await this.readOwner(`${lockDir()}/held/owner`)
    return owner?.holder === holder
  }

  private async release(holder: string): Promise<void> {
    this.stopHeartbeat()
    const owner = await this.readOwner(`${lockDir()}/held/owner`)
    if (owner?.holder !== holder) return
    await this.fs.remove(`${lockDir()}/held`).catch(() => undefined)
  }

  private async writeOwner(path: string, holder: string, acquiredAt: number): Promise<void> {
    await this.fs.writeBytes(path, encodeOwner(holder, acquiredAt))
  }

  private async readOwner(path: string): Promise<OwnerFile | null> {
    try {
      if (!(await this.fs.stat(path))) return null
      return decodeOwner(await this.fs.readBytes(path))
    } catch {
      return null
    }
  }

  private async deleteOtherSnapshots(generation: number): Promise<void> {
    const entries = await this.listOrEmpty(`${SEARCH_CACHE_DIR}/snapshots`)
    for (const entry of entries) {
      if (entry.kind !== 'file' || !/^[0-9]+\.vane$/.test(entry.name)) continue
      if (entry.name === `${generation}.vane`) continue
      await this.fs.remove(`${SEARCH_CACHE_DIR}/snapshots/${entry.name}`).catch(() => undefined)
    }
  }

  private async deleteOtherSignatures(previous: string | undefined): Promise<void> {
    const keep = new Set<string>([this.signature])
    if (previous && /^[0-9a-f]{64}$/.test(previous)) keep.add(previous)
    const entries = await this.listOrEmpty(`${SEARCH_CACHE_DIR}/vectors`)
    for (const entry of entries) {
      if (entry.kind !== 'directory' || keep.has(entry.name)) continue
      await this.fs.remove(`${SEARCH_CACHE_DIR}/vectors/${entry.name}`).catch(() => undefined)
    }
  }

  private shardDir(): string {
    return `${this.vectorDir()}/shards`
  }

  private openPath(): string {
    return `${this.shardDir()}/open.bin`
  }

  private packPath(): string {
    return `${this.vectorDir()}/pack.bin`
  }

  private vectorDir(): string {
    if (!/^[0-9a-f]{64}$/.test(this.signature)) throw new Error('Invalid embedding signature')
    return `${SEARCH_CACHE_DIR}/vectors/${this.signature}`
  }
}

interface DiskRecords {
  sealed: Map<string, Uint8Array>
  open: Map<string, Uint8Array>
  pack: Map<string, Uint8Array>
  shardNames: string[]
  nextShard: number
}

function lockDir(): string {
  return `${SEARCH_CACHE_DIR}/flush-lock`
}

function manifestPath(): string {
  return `${SEARCH_CACHE_DIR}/manifest.json`
}

function snapshotFile(generation: number): string {
  if (!Number.isInteger(generation) || generation < 1) throw new Error('Invalid snapshot generation')
  return `${SEARCH_CACHE_DIR}/snapshots/${generation}.vane`
}

function shardName(index: number): string {
  return String(index).padStart(8, '0') + '.bin'
}

function parseManifest(bytes: Uint8Array): SearchCacheManifest | null {
  try {
    const parsed = JSON.parse(decoder.decode(bytes)) as Partial<SearchCacheManifest>
    if (parsed.format !== 1 || parsed.textAlgo !== 1) return null
    const embedding = parsed.embedding
    if (!embedding || typeof embedding.signature !== 'string' || !/^[0-9a-f]{64}$/.test(embedding.signature)) return null
    if (typeof embedding.model !== 'string' || typeof embedding.dim !== 'number') return null
    if (!Array.isArray(parsed.notes)) return null
    const notes: BaselineNote[] = []
    for (const note of parsed.notes) {
      if (!note || typeof note.id !== 'string' || typeof note.contentHash !== 'string') return null
      if (!/^[0-9a-f]{64}$/.test(note.contentHash)) return null
      notes.push({ id: note.id, contentHash: note.contentHash })
    }
    let snapshot: SearchCacheManifest['snapshot'] = null
    if (parsed.snapshot !== null && parsed.snapshot !== undefined) {
      const raw = parsed.snapshot
      if (typeof raw.generation !== 'number' || typeof raw.corpusHash !== 'string') return null
      if (typeof raw.bytes !== 'number' || typeof raw.dim !== 'number') return null
      snapshot = {
        generation: raw.generation,
        corpusHash: raw.corpusHash,
        bytes: raw.bytes,
        dim: raw.dim,
      }
    }
    return {
      format: 1,
      textAlgo: 1,
      embedding: {
        signature: embedding.signature,
        model: embedding.model,
        dim: embedding.dim,
        ...(typeof embedding.previousSignature === 'string' ? { previousSignature: embedding.previousSignature } : {}),
      },
      notes,
      snapshot,
    }
  } catch {
    return null
  }
}
