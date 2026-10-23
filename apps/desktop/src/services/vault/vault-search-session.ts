import { raw } from '@rabjs/react'
import { isArchived, type StrideNote } from '@stride/core/note'
import { memorySearchOpener, type SearchBackend } from '@stride/platform'
import { EmbeddingClient } from '../../../../../packages/core/src/embeddings'
import { searchIndex, type SearchHit } from '../../../../../packages/core/src/search'
import {
  docsForRebuild,
  hashIndexTexts,
  indexText,
  QUERY_VECTOR_CACHE,
  SearchDiskCache,
  SNAPSHOT_FLUSH_MS,
  type CacheNote,
} from '../../../../../packages/core/src/search-cache'
import { rankSearch } from '../../../../../packages/core/src/search-rank'
import type { EmbeddingRuntime } from '../settings/settings.service'
import { isMemoryFixture } from '../platform/runtime'
import type { VaultService } from './vault.service'

const EMBED_BATCH = 16
const EMBED_ABORT_POLL_MS = 200

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export const embeddingClient = new EmbeddingClient((input, init) => globalThis.fetch(input, init))

interface SearchSession {
  backend: SearchBackend
  capture: (() => Promise<Uint8Array>) | null
  restored: boolean
}

interface SearchSlot {
  disk: SearchDiskCache | null
  session: SearchSession | null
  queries: { key: string; vector: number[] }[]
  signature: string
  flushTimer: ReturnType<typeof setTimeout> | null
  pagehideBound: boolean
  fsKey: object | null
}

const searchSlots = new WeakMap<object, SearchSlot>()

export function searchSlot(service: object): SearchSlot {
  const key = raw(service)
  let slot = searchSlots.get(key)
  if (!slot) {
    slot = {
      disk: null,
      session: null,
      queries: [],
      signature: '',
      flushTimer: null,
      pagehideBound: false,
      fsKey: null,
    }
    searchSlots.set(key, slot)
  }
  return slot
}

function nextMacrotask(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0)
  })
}

export async function runSearch(vault: VaultService) {
  vault.error = ''
  try {
    if (!vault.index) throw new Error('Open a vault first')
    const runtime = await vault.currentEmbedding()
    const active = runtime.active && vault.index.dim === runtime.dim
    const result = await searchIndex(
      vault.index,
      vault.searchQuery,
      8,
      active ? embeddingSettings(vault, runtime) : null,
      queryEmbeddingClient(vault),
      vectorGapFor(vault, runtime),
    )
    vault.searchHits = result.hits
    vault.searchMode = result.mode
    publishGap(vault, runtime, 'keep', result.degraded)
  } catch (error) {
    vault.error = errorText(error)
  }
}

export async function queryRanked(vault: VaultService, text: string) {
  const trimmed = text.trim()
  if (!trimmed) return []
  const notes = vault.notes.filter((note) => !isArchived(note)).map((note) => ({
    id: note.id,
    title: note.title,
    text: indexText(note),
  }))
  const allowed = new Set(notes.map((note) => note.id))
  const found = vault.index ? await rankedHits(vault, trimmed, 30) : []
  return rankSearch(trimmed, notes, found.filter((hit) => allowed.has(hit.id)))
}

export function startRebuild(vault: VaultService, epoch: number, docs: { id: string; text: string }[]): Promise<void> {
  const rebuilder = vault.rebuilder
  if (!rebuilder) return Promise.resolve()
  rebuilder.begin()
  const shouldContinue = () => epoch === vault.rebuildEpoch
  const noteCount = docs.length
  return prepareIndexed(vault, docs, shouldContinue, 'rebuild').then((prepared) => {
    if (!prepared || !shouldContinue()) {
      rebuilder.cancel()
      return
    }
    vault.indexWork = 'indexing'
    return rebuilder.rebuild(prepared, {
      shouldContinue,
      onProgress: (done, total) => {
        if (!shouldContinue()) return
        vault.indexDone = done
        vault.indexTotal = Math.max(noteCount, total)
        vault.indexPhase = 'rebuilding'
        vault.indexWork = 'indexing'
      },
    }).then(async (result) => {
      if (!shouldContinue() || result.aborted) return
      const runtime = await vault.currentEmbedding()
      const openDim = vault.index?.dim ?? 0
      const gap = vectorGapFor(vault, runtime)
      vault.indexPhase = 'ready'
      vault.indexTotal = noteCount
      if (runtime.active && openDim > 0 && gap > 0) {
        vault.indexWork = 'embedding'
        vault.indexDone = Math.max(0, noteCount - gap)
      } else {
        vault.indexWork = 'idle'
        vault.indexDone = noteCount
      }
      publishGap(vault, runtime, 'keep')
      await flushDisk(vault, gap === 0)
      searchSlot(vault).disk?.dropPackMap()
    }, () => {
      if (!shouldContinue()) return
      vault.indexPhase = 'error'
      vault.indexWork = 'idle'
    })
  }, () => {
    rebuilder.cancel()
    console.warn('stride search cache: rebuild-prepare')
    if (!shouldContinue()) return
    if (vault.phase === 'ready' && vault.indexPhase === 'rebuilding') vault.indexPhase = 'ready'
  })
}

export function retryIndex(vault: VaultService) {
  if (vault.phase !== 'ready' || !vault.rebuilder || vault.indexPhase !== 'error') return
  vault.rebuildEpoch += 1
  const epoch = vault.rebuildEpoch
  const snapshot = vault.notes.map((note) => ({ id: note.id, text: indexText(note) }))
  vault.indexDone = 0
  vault.indexTotal = snapshot.length
  vault.indexPhase = snapshot.length > 0 ? 'rebuilding' : 'ready'
  vault.indexWork = 'idle'
  vault.rebuildDone = snapshot.length > 0 ? startRebuild(vault, epoch, snapshot) : Promise.resolve()
}

export function retryMisses(vault: VaultService) {
  if (vault.phase !== 'ready' || !vault.rebuilder || vault.indexPhase !== 'ready' || vault.indexWork !== 'embedding') return
  const epoch = vault.rebuildEpoch
  void embedMisses(vault, epoch)
}

export async function openSearchSession(
  vault: VaultService,
  vaultKey: string,
  dim: number,
  useMemory = isMemoryFixture(),
): Promise<SearchSession> {
  if (useMemory) {
    const backend = await memorySearchOpener().open({ vaultKey, dim })
    return { backend, capture: null, restored: false }
  }
  const { vaneWebSearchOpener, VANE_SNAPSHOT_RESTORE } = await import('@stride/search-web')
  const opener = vaneWebSearchOpener()
  let snapshot: Uint8Array | null = null
  if (VANE_SNAPSHOT_RESTORE) {
    const disk = searchSlot(vault).disk
    if (disk && await disk.snapshotUsable(dim)) snapshot = await disk.readSnapshot()
  }
  const opened = await opener.open({ vaultKey, dim }, snapshot)
  return {
    backend: opened.backend,
    capture: opened.capture,
    restored: opened.restored === true && snapshot !== null,
  }
}

export async function upsertIndexed(vault: VaultService, note: StrideNote) {
  if (!vault.rebuilder) return
  try {
    const prepared = await prepareIndexed(vault, [{ id: note.id, text: indexText(note) }], () => true, 'upsert')
    if (!prepared) return
    await vault.rebuilder.upsert(prepared)
  } catch {
    console.warn('stride search cache: upsert-failed')
  }
}

export async function rankedHits(vault: VaultService, text: string, topK: number): Promise<SearchHit[]> {
  const index = vault.index
  if (!index) return []
  const runtime = await vault.currentEmbedding()
  const active = runtime.active && index.dim === runtime.dim
  const result = await searchIndex(
    index,
    text,
    topK,
    active ? embeddingSettings(vault, runtime) : null,
    queryEmbeddingClient(vault),
    vectorGapFor(vault, runtime),
  )
  vault.searchMode = result.mode
  publishGap(vault, runtime, 'keep', result.degraded)
  return result.hits
}

export async function prepareIndexed(
  vault: VaultService,
  docs: { id: string; text: string }[],
  shouldContinue: () => boolean,
  mode: 'rebuild' | 'upsert',
): Promise<{ id: string; text: string; vector?: number[] }[] | null> {
  const runtime = await vault.currentEmbedding()
  const openDim = vault.index?.dim ?? 0
  const slot = searchSlot(vault)
  const disk = slot.disk
  const hashes = await hashIndexTexts(docs.map((doc) => doc.text))
  if (!shouldContinue()) return null
  const notes: CacheNote[] = docs.map((doc, index) => ({
    id: doc.id,
    text: doc.text,
    contentHash: hashes[index] ?? '',
  }))
  if (!runtime.active || openDim !== runtime.dim || openDim === 0) {
    if (disk && disk.dim === openDim) {
      if (mode === 'rebuild') retainNotes(vault, disk, notes)
      for (const note of notes) disk.setNote(note.id, note.contentHash)
      scheduleFlush(vault, false)
    }
    publishGap(vault, runtime, mode === 'rebuild' ? 'sync' : 'keep')
    return notes.map((note) => ({ id: note.id, text: note.text }))
  }
  try {
    if (disk) {
      if (mode === 'rebuild') retainNotes(vault, disk, notes)
      for (const note of notes) disk.setNote(note.id, note.contentHash)
      await disk.loadPackIfNeeded(notes.map((note) => note.contentHash))
    }
  } catch {
    console.warn('stride search cache: read-failed')
    slot.disk = null
  }
  const current = searchSlot(vault).disk
  const restored = slot.session?.restored === true && current !== null && await current.snapshotUsable(openDim).catch(() => false)
  const plan = current ? current.plan(notes, mode === 'rebuild' && restored) : null
  if (current && mode === 'upsert') current.recompute(current.liveNotes())
  if (current && mode === 'rebuild' && restored && plan && plan.remove.length > 0) {
    await vault.rebuilder?.remove(plan.remove)
  }
  const embedNotes = plan ? plan.embed : notes
  if (mode === 'rebuild') {
    vault.indexTotal = notes.length
    vault.indexDone = notes.length - embedNotes.length
    publishGap(vault, runtime, 'sync')
  }
  const vectors = new Map<string, number[]>()
  if (current) {
    for (const note of notes) {
      if (!embedNotes.some((item) => item.id === note.id)) {
        const vector = current.vector(note.contentHash)
        if (vector) vectors.set(note.id, vector)
      }
    }
  }
  const embedded = await embedGroups(vault, embedNotes, runtime, shouldContinue, current)
  if (!embedded) return null
  for (const [id, vector] of embedded) vectors.set(id, vector)
  if (current) {
    current.recompute(current.liveNotes())
    if (current.vectorGap === 0) vault.indexWork = 'idle'
    publishGap(vault, runtime, vault.indexPhase === 'rebuilding' && mode === 'upsert' ? 'keep' : 'sync')
    if (mode === 'rebuild') vault.indexDone = Math.max(vault.indexDone, notes.length - current.vectorGap)
  } else if (embedded.size < embedNotes.length && runtime.intended) {
    vault.searchDegraded = true
  }
  const base: { id: string; text: string; vector?: number[] }[] = current
    ? docsForRebuild(restored, plan ?? {
      restoreSnapshot: false,
      snapshotGeneration: null,
      remove: [],
      unchanged: [],
      cached: [],
      embed: notes,
    }, notes, (hash) => current.vector(hash), current.baselineNotes())
    : notes.map((note) => ({ id: note.id, text: note.text }))
  const byId = new Map(base.map((doc) => [doc.id, doc]))
  for (const note of notes) {
    const vector = vectors.get(note.id)
    if (!vector) continue
    const existing = byId.get(note.id)
    if (existing) existing.vector = vector
    else byId.set(note.id, { id: note.id, text: note.text, vector })
  }
  if (mode === 'upsert') scheduleFlush(vault, false)
  return [...byId.values()]
}

export async function embedMisses(vault: VaultService, epoch: number) {
  const disk = searchSlot(vault).disk
  const runtime = await vault.currentEmbedding()
  if (!disk || !vault.rebuilder || epoch !== vault.rebuildEpoch) return
  const docs = vault.notes.map((note) => ({ id: note.id, text: indexText(note) }))
  const hashes = await hashIndexTexts(docs.map((doc) => doc.text))
  const notes: CacheNote[] = docs.map((doc, index) => ({
    id: doc.id,
    text: doc.text,
    contentHash: hashes[index] ?? '',
  }))
  for (const note of notes) disk.setNote(note.id, note.contentHash)
  await disk.loadPackIfNeeded(notes.map((note) => note.contentHash))
  const plan = disk.plan(notes, false)
  const embedded = await embedGroups(vault, plan.embed, runtime, () => epoch === vault.rebuildEpoch, disk)
  if (!embedded || epoch !== vault.rebuildEpoch) return
  const rows = []
  for (const note of plan.embed) {
    const vector = embedded.get(note.id)
    if (!vector) continue
    rows.push({ id: note.id, text: note.text, vector })
  }
  if (rows.length > 0) await vault.rebuilder.upsert(rows)
  disk.recompute(disk.liveNotes())
  const gap = vectorGapFor(vault, runtime)
  vault.indexTotal = notes.length
  vault.indexDone = Math.max(0, notes.length - gap)
  publishGap(vault, runtime, 'sync')
  await flushDisk(vault, gap === 0)
  disk.dropPackMap()
}

export function retainNotes(vault: VaultService, disk: SearchDiskCache, notes: readonly CacheNote[]) {
  const ids = new Set(notes.map((note) => note.id))
  for (const row of disk.liveNotes()) {
    if (!ids.has(row.id)) disk.removeNote(row.id)
  }
}

export async function embedGroups(
  vault: VaultService,
  embedNotes: readonly CacheNote[],
  runtime: EmbeddingRuntime,
  shouldContinue: () => boolean,
  disk: SearchDiskCache | null,
): Promise<Map<string, number[]> | null> {
  const found = new Map<string, number[]>()
  const groups = new Map<string, { text: string; ids: string[] }>()
  for (const note of embedNotes) {
    const group = groups.get(note.contentHash)
    if (group) group.ids.push(note.id)
    else groups.set(note.contentHash, { text: note.text, ids: [note.id] })
  }
  const rows = [...groups.entries()]
  for (let offset = 0; offset < rows.length; offset += EMBED_BATCH) {
    if (offset > 0) await nextMacrotask()
    if (!shouldContinue()) return null
    const slice = rows.slice(offset, offset + EMBED_BATCH)
    let vectors: number[][] | null = null
    // A later open only flips shouldContinue. Abort the in-flight embed so that open is not stuck on fetch.
    const controller = new AbortController()
    const watch = setInterval(() => {
      if (!shouldContinue()) controller.abort()
    }, EMBED_ABORT_POLL_MS)
    try {
      if (!shouldContinue()) controller.abort()
      vectors = await embeddingClient.embed(
        slice.map(([, group]) => group.text),
        embeddingSettings(vault, runtime),
        controller.signal,
      )
    } catch {
      vectors = null
    } finally {
      clearInterval(watch)
    }
    if (!shouldContinue()) return null
    if (!vectors || vectors.length !== slice.length) continue
    let covered = 0
    for (let index = 0; index < slice.length; index += 1) {
      const hash = slice[index]?.[0]
      const group = slice[index]?.[1]
      const vector = vectors[index]
      if (!hash || !group || !vector || vector.length !== runtime.dim) continue
      if (vector.some((value) => !Number.isFinite(value))) continue
      disk?.remember(hash, vector, true)
      covered += group.ids.length
      for (const id of group.ids) found.set(id, vector)
    }
    if (covered > 0 && vault.indexWork === 'embedding') vault.indexDone += covered
    if (disk && covered > 0) {
      try {
        await disk.flush({ live: disk.liveNotes(), commit: false })
      } catch {
        console.warn('stride search cache: flush-failed')
      }
    }
  }
  return found
}

export function embeddingSettings(vault: VaultService, runtime: EmbeddingRuntime) {
  return {
    endpoint: runtime.endpoint,
    model: runtime.model,
    apiKey: runtime.apiKey,
    dim: runtime.dim,
  }
}

export function vectorGapFor(vault: VaultService, runtime: EmbeddingRuntime): number {
  const openDim = vault.index?.dim ?? 0
  const disk = searchSlot(vault).disk
  if (!disk || openDim === 0 || !runtime.active) return 0
  return disk.vectorGap
}

export function publishGap(vault: VaultService, runtime: EmbeddingRuntime, work: 'sync' | 'keep', queryDegraded = false) {
  const openDim = vault.index?.dim ?? 0
  const gap = vectorGapFor(vault, runtime)
  if (work === 'sync') {
    vault.indexWork = runtime.active && openDim > 0 && gap > 0 ? 'embedding' : 'idle'
  }
  vault.searchDegraded = runtime.intended && (
    !runtime.active
    || openDim !== runtime.dim
    || gap > 0
    || queryDegraded
  )
}

export function queryEmbeddingClient(vault: VaultService): EmbeddingClient {
  const slot = searchSlot(vault)
  return new EmbeddingClient(async (input, init) => {
    let text = ''
    try {
      const body = JSON.parse(String(init?.body)) as { input?: string[] }
      text = body.input?.length === 1 ? body.input[0] ?? '' : ''
    } catch {
      text = ''
    }
    const key = `${slot.signature}\n${text}`
    if (text) {
      const hit = slot.queries.find((item) => item.key === key)
      if (hit) {
        return new Response(JSON.stringify({
          data: [{ index: 0, embedding: hit.vector }],
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
    }
    const response = await globalThis.fetch(input, init)
    if (text && response.ok) {
      try {
        const json = await response.clone().json() as { data?: { embedding?: number[] }[] }
        const vector = json.data?.[0]?.embedding
        if (vector && vector.length > 0) {
          slot.queries.unshift({ key, vector })
          while (slot.queries.length > QUERY_VECTOR_CACHE) slot.queries.pop()
        }
      } catch {
        // A bad body is not a cache hit.
      }
    }
    return response
  })
}

export function bindPagehide(vault: VaultService) {
  const slot = searchSlot(vault)
  if (slot.pagehideBound || typeof window === 'undefined') return
  slot.pagehideBound = true
  window.addEventListener('pagehide', () => {
    void flushDiskNow(vault)
  })
}

export function scheduleFlush(vault: VaultService, immediate: boolean) {
  const slot = searchSlot(vault)
  const disk = slot.disk
  if (!disk) return
  if (disk.vectorGap > 0 || (immediate && vault.indexPhase === 'ready')) {
    void flushDisk(vault, immediate && vault.indexPhase === 'ready' && disk.vectorGap === 0)
    return
  }
  if (slot.flushTimer) clearTimeout(slot.flushTimer)
  slot.flushTimer = setTimeout(() => {
    slot.flushTimer = null
    void flushDisk(vault, vault.indexPhase === 'ready' && (searchSlot(vault).disk?.vectorGap ?? 1) === 0)
  }, SNAPSHOT_FLUSH_MS)
}

export async function flushDiskNow(vault: VaultService): Promise<void> {
  const slot = searchSlot(vault)
  if (slot.flushTimer) {
    clearTimeout(slot.flushTimer)
    slot.flushTimer = null
  }
  const disk = slot.disk
  if (!disk) return
  await flushDisk(vault, vault.indexPhase === 'ready' && disk.vectorGap === 0)
}

export async function flushDisk(vault: VaultService, commit: boolean): Promise<void> {
  const slot = searchSlot(vault)
  const disk = slot.disk
  if (!disk) return
  if (slot.flushTimer) {
    clearTimeout(slot.flushTimer)
    slot.flushTimer = null
  }
  let snapshot: Uint8Array | null = null
  if (commit && disk.vectorGap === 0 && slot.session?.capture) {
    try {
      snapshot = await slot.session.capture()
    } catch {
      console.warn('stride search cache: snapshot-capture')
      snapshot = null
    }
  }
  try {
    await disk.flush({
      live: disk.liveNotes(),
      commit: commit && disk.vectorGap === 0,
      snapshot,
    })
  } catch {
    console.warn('stride search cache: flush-failed')
  }
}

export async function removeIndexed(vault: VaultService, ids: string[]) {
  if (!vault.rebuilder || ids.length === 0) return
  const disk = searchSlot(vault).disk
  if (disk) {
    for (const id of ids) disk.removeNote(id)
    disk.recompute(disk.liveNotes())
    scheduleFlush(vault, false)
  }
  await vault.rebuilder.remove(ids)
}
