import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createVane } from '@vane-rs/web'
import type { Doc, Hit, Schema, SearchQuery as VaneQuery, VaneWorkerOpts } from '@vane-rs/web'
import { PlatformError, type SearchBackend } from '@stride/platform'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { createVaneSearchOpener, VANE_SNAPSHOT_RESTORE, vaneWebSearchOpener, type VaneCapableOpener, type VaneFactory, type VaneSession } from './index.ts'

interface MemoryOptions {
  fields?: 'text' | 'none'
}

interface OpenedSchema {
  name: string
  schema: Schema
  tokenizer?: string
  dbPath: string
  vfs?: string
}

interface JiebaDictBytes {
  dictData: Uint8Array
  dictSha256: string
}

const require = createRequire(import.meta.url)

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  for (let i = 0; i < left.byteLength; i += 1) {
    if (left[i] !== right[i]) return false
  }
  return true
}

function hexOf(bytes: Uint8Array): string {
  let hex = ''
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0')
  return hex
}

function packageFile(specifier: string): string {
  return require.resolve(specifier)
}

let packagedDict: Promise<JiebaDictBytes> | undefined

function loadPackagedDictForTest(): Promise<JiebaDictBytes> {
  packagedDict ??= readPackagedDict()
  return packagedDict
}

// Vitest rewrites `?url` to a `/@fs/` path. Node fetch cannot read it; map only that prefix back to the package file.
const nativeFetch = globalThis.fetch.bind(globalThis)
globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  if (url.startsWith('/@fs/')) {
    const path = decodeURIComponent(url.slice('/@fs'.length).split('?')[0] ?? '')
    const bytes = await readFile(path)
    return new Response(bytes)
  }
  return nativeFetch(input, init)
}

afterAll(() => {
  globalThis.fetch = nativeFetch
})

async function readPackagedDict(): Promise<JiebaDictBytes> {
  const dictData = new Uint8Array(await readFile(packageFile('@vane-rs/dict-zh/dict.bin')))
  const prefix = new Uint8Array(await readFile(packageFile('@vane-rs/dict-zh/sha256_prefix.bin')))
  const dictSha256 = hexOf(prefix)
  if (dictData.byteLength === 0 || !/^[0-9a-f]{16}$/.test(dictSha256)) {
    throw new Error(`packaged jieba dictionary is unusable (${dictData.byteLength} bytes, sha ${dictSha256})`)
  }
  return { dictData, dictSha256 }
}

function createMemoryVane(options: MemoryOptions = {}): {
  factory: VaneFactory
  opened: OpenedSchema[]
  queries: VaneQuery[]
  added: Doc[]
  ops: string[]
  workerOpts: VaneWorkerOpts[]
} {
  const stores = new Map<string, Map<string, Doc>>()
  const opened: OpenedSchema[] = []
  const queries: VaneQuery[] = []
  const added: Doc[] = []
  const ops: string[] = []
  const workerOpts: VaneWorkerOpts[] = []

  const factory: VaneFactory = (opts?: VaneWorkerOpts) => {
    if (opts) workerOpts.push(opts)
    const dbPath = opts?.dbPath ?? 'vane.db'
    const key = `${opts?.vfs ?? 'memory'}\0${dbPath}`
    const docs = stores.get(key) ?? new Map<string, Doc>()
    stores.set(key, docs)
    let closed = false
    const guard = () => {
      if (closed) throw new Error('vane worker closed')
    }
    const session: VaneSession = {
      async open() {
        guard()
      },
      async collection(name, schema, colOpts) {
        guard()
        opened.push({
          name,
          schema,
          tokenizer: colOpts?.tokenizer,
          dbPath,
          vfs: opts?.vfs,
        })
        return 1
      },
      async add(_col, rows) {
        guard()
        for (const row of rows) {
          ops.push(`add:${row.id}`)
          docs.set(row.id, { id: row.id, text: row.text, vector: row.vector })
          added.push(row)
        }
        return rows.length
      },
      async flush() {
        guard()
      },
      async search(_col, query) {
        guard()
        queries.push(query)
        if (query.mode === 'hybrid' && (!query.vector || query.vector.length === 0)) {
          throw new Error('Hybrid search needs a vector')
        }
        const needle = (query.text ?? '').toLowerCase()
        const hits: Hit[] = []
        for (const doc of docs.values()) {
          const hay = (doc.text ?? '').toLowerCase()
          if (!needle || !hay.includes(needle)) continue
          hits.push({
            id: doc.id,
            score: 1 + hay.split(needle).length,
            fields: options.fields === 'none' ? null : { text: doc.text ?? '' },
          })
        }
        hits.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        const limit = query.topK && query.topK > 0 ? query.topK : 0
        return hits.slice(0, limit)
      },
      async delete(_col, ids) {
        guard()
        let removed = 0
        for (const id of ids) {
          ops.push(`delete:${id}`)
          if (docs.delete(id)) removed += 1
        }
        return removed
      },
      async close() {
        guard()
        closed = true
      },
    }
    return Promise.resolve(session)
  }

  return { factory, opened, queries, added, ops, workerOpts }
}

const backends: SearchBackend[] = []

function openerFor(memory = createMemoryVane()): VaneCapableOpener {
  return createVaneSearchOpener(memory.factory, 'memory')
}

async function openBackend(opener: VaneCapableOpener, vaultKey: string, dim = 0): Promise<SearchBackend> {
  const session = await opener.open({ vaultKey, dim })
  backends.push(session.backend)
  return session.backend
}

afterEach(async () => {
  await Promise.all(backends.splice(0).map(async (backend) => {
    try {
      await backend.close()
    } catch {
      // already closed
    }
  }))
})

describe('vane web search', () => {
  it('ranks a distinctive term and snippets a window around it', async () => {
    const memory = createMemoryVane()
    const backend = await openBackend(openerFor(memory), 'vault-a')
    const term = 'xylophonequartz'
    const text = `${'p'.repeat(100)}${term}${'s'.repeat(200)}`
    await backend.upsert([
      { id: 'alpha', text },
      { id: 'beta', text: 'unrelated soup recipe' },
    ])
    const hits = await backend.search({ text: term, topK: 5, mode: 'text' })
    expect(hits[0]?.id).toBe('alpha')
    expect(hits.map((hit) => hit.id)).not.toContain('beta')
    const at = text.indexOf(term)
    expect(hits[0]?.snippet).toBe(text.slice(Math.max(0, at - 40), Math.min(text.length, at + 80)))
    expect(hits[0]?.snippet).toContain(term)
    expect(memory.opened[0]?.name).toBe('notes')
    expect(memory.opened[0]?.tokenizer).toBe('jieba')
    expect(memory.opened[0]?.schema.fields).toEqual([
      { name: 'text', type: 'text' },
      { name: 'vec', type: 'vector', dim: 1, metric: 'cosine' },
    ])
    expect(memory.opened[0]?.dbPath).toMatch(/^[A-Za-z0-9._-]+$/)
    expect(memory.opened[0]?.vfs).toBe('memory')
    const dict = memory.workerOpts[0]?.dictData
    expect(dict).toBeInstanceOf(Uint8Array)
    const bytes = dict as Uint8Array
    const packaged = await loadPackagedDictForTest()
    expect(bytes.byteLength).toBeGreaterThan(0)
    expect(bytes.byteLength).toBe(packaged.dictData.byteLength)
    expect(sameBytes(bytes, packaged.dictData)).toBe(true)
    expect(memory.workerOpts[0]?.dictSha256).toMatch(/^[0-9a-f]{16}$/)
    expect(memory.workerOpts[0]?.dictSha256).toBe(packaged.dictSha256)
    expect(memory.workerOpts[0]?.dictUrl).toBeUndefined()
    console.info(`dictData.byteLength=${bytes.byteLength} dictSha256=${memory.workerOpts[0]?.dictSha256}`)
  })

  it('builds the snippet from the local copy when hit fields are empty', async () => {
    const memory = createMemoryVane({ fields: 'none' })
    const backend = await openBackend(openerFor(memory), 'vault-local')
    await backend.upsert([
      { id: 'alpha', text: `${'p'.repeat(80)}moss-term${'s'.repeat(80)}` },
      { id: 'beta', text: 'other' },
    ])
    const hits = await backend.search({ text: 'moss-term', topK: 3, mode: 'text' })
    expect(hits[0]?.id).toBe('alpha')
    expect(hits[0]?.snippet).toContain('moss-term')
    expect(hits[0]?.snippet?.length).toBeGreaterThan(0)
  })

  it('returns a Chinese note for 苔藓 with a non-empty snippet', async () => {
    const backend = await openBackend(openerFor(), 'vault-zh')
    const text = '森林地面长满了苔藓和蕨类植物，潮湿而柔软，适合慢慢走路观察。'
    await backend.upsert([
      { id: 'moss', text },
      { id: 'other', text: '今天只写了一份采购清单' },
    ])
    const hits = await backend.search({ text: '苔藓', topK: 5, mode: 'text' })
    expect(hits.map((hit) => hit.id)).toContain('moss')
    expect(hits[0]?.id).toBe('moss')
    expect(hits[0]?.snippet).toContain('苔藓')
    expect(hits[0]?.snippet?.length).toBeGreaterThan(0)
  })

  it('deletes an id before adding it again on the second upsert', async () => {
    const memory = createMemoryVane()
    const backend = await openBackend(openerFor(memory), 'vault-replace')
    await backend.upsert([{ id: 'same', text: 'first xylophonequartz' }])
    await backend.upsert([{ id: 'same', text: 'second xylophonequartz' }])
    expect(memory.ops).toEqual(['delete:same', 'add:same', 'delete:same', 'add:same'])
    const hits = await backend.search({ text: 'second', topK: 5, mode: 'text' })
    expect(hits.map((hit) => hit.id)).toEqual(['same'])
  })

  it('misses an id after remove', async () => {
    const backend = await openBackend(openerFor(), 'vault-remove')
    await backend.upsert([
      { id: 'alpha', text: 'alpha xylophonequartz' },
      { id: 'beta', text: 'beta xylophonequartz' },
    ])
    await backend.remove(['alpha'])
    const hits = await backend.search({ text: 'xylophonequartz', topK: 10, mode: 'text' })
    expect(hits.map((hit) => hit.id)).toEqual(['beta'])
  })

  it('throws PlatformError io after close', async () => {
    const backend = await openBackend(openerFor(), 'vault-close')
    await backend.upsert([{ id: 'alpha', text: 'alpha xylophonequartz' }])
    await backend.close()
    await expect(backend.search({ text: 'xylophonequartz', topK: 5, mode: 'text' })).rejects.toBeInstanceOf(PlatformError)
    await expect(backend.search({ text: 'xylophonequartz', topK: 5, mode: 'text' })).rejects.toMatchObject({ code: 'io' })
    await expect(backend.upsert([{ id: 'beta', text: 'nope' }])).rejects.toMatchObject({ code: 'io' })
  })

  it('keeps vault keys on separate databases', async () => {
    const memory = createMemoryVane()
    const opener = openerFor(memory)
    const left = await openBackend(opener, 'vault-left')
    const right = await openBackend(opener, 'vault-right')
    await left.upsert([{ id: 'only-left', text: 'left-marker xylophonequartz' }])
    await right.upsert([{ id: 'only-right', text: 'right-marker quartzviolin' }])
    expect((await left.search({ text: 'quartzviolin', topK: 5, mode: 'text' })).map((hit) => hit.id)).not.toContain('only-right')
    expect((await right.search({ text: 'xylophonequartz', topK: 5, mode: 'text' })).map((hit) => hit.id)).not.toContain('only-left')
    expect((await left.search({ text: 'xylophonequartz', topK: 5, mode: 'text' }))[0]?.id).toBe('only-left')
    expect((await right.search({ text: 'quartzviolin', topK: 5, mode: 'text' }))[0]?.id).toBe('only-right')

    const slash = await openBackend(opener, 'a/b')
    const underscore = await openBackend(opener, 'a_b')
    await slash.upsert([{ id: 'slash', text: 'slash-only-term' }])
    await underscore.upsert([{ id: 'under', text: 'under-only-term' }])
    expect((await slash.search({ text: 'under-only-term', topK: 5, mode: 'text' }))).toEqual([])
    expect((await underscore.search({ text: 'slash-only-term', topK: 5, mode: 'text' }))).toEqual([])
    const dotted = await openBackend(opener, '..')
    await dotted.upsert([{ id: 'dots', text: 'dot-dot-term' }])
    expect(await left.search({ text: 'dot-dot-term', topK: 5, mode: 'text' })).toEqual([])
    expect(new Set(memory.opened.map((row) => row.dbPath)).size).toBe(5)
    for (const row of memory.opened) {
      expect(row.dbPath).toMatch(/^[A-Za-z0-9._-]+$/)
      expect(row.dbPath.includes('..')).toBe(false)
    }
  })

  it('reopens a vault and still finds flushed documents', async () => {
    const memory = createMemoryVane()
    const opener = openerFor(memory)
    const first = await openBackend(opener, 'vault-persist')
    await first.upsert([{ id: 'kept', text: `${'p'.repeat(50)}persist-term${'s'.repeat(50)}` }])
    await first.close()
    const second = await openBackend(opener, 'vault-persist')
    const hits = await second.search({ text: 'persist-term', topK: 5, mode: 'text' })
    expect(hits[0]?.id).toBe('kept')
    expect(hits[0]?.snippet).toContain('persist-term')
  })

  it('passes rrf fusion only when the hybrid vector width matches dim', async () => {
    const memory = createMemoryVane()
    const backend = await openBackend(openerFor(memory), 'vault-rrf', 4)
    await backend.upsert([{ id: 'alpha', text: 'alpha xylophonequartz', vector: [1, 0, 0, 0] }])
    const hits = await backend.search({ text: 'xylophonequartz', topK: 5, mode: 'hybrid', vector: [1, 0, 0, 0] })
    expect(hits[0]?.id).toBe('alpha')
    expect(memory.queries.at(-1)).toEqual({
      text: 'xylophonequartz',
      topK: 5,
      mode: 'hybrid',
      vector: [1, 0, 0, 0],
      fusion: 'rrf',
    })
    await backend.search({ text: 'xylophonequartz', topK: 5, mode: 'hybrid', vector: [1, 0, 0] })
    expect(memory.queries.at(-1)).toEqual({ text: 'xylophonequartz', topK: 5, mode: 'text' })

    const placeholder = createMemoryVane()
    const narrow = await openBackend(openerFor(placeholder), 'vault-rrf-placeholder', 0)
    await narrow.upsert([{ id: 'alpha', text: 'alpha xylophonequartz' }])
    await narrow.search({ text: 'xylophonequartz', topK: 3, mode: 'hybrid', vector: [0] })
    expect(placeholder.queries.at(-1)).toEqual({ text: 'xylophonequartz', topK: 3, mode: 'text' })
  })

  it('searches BM25 when hybrid is requested without a vector', async () => {
    const memory = createMemoryVane()
    const backend = await openBackend(openerFor(memory), 'vault-hybrid')
    await backend.upsert([
      { id: 'alpha', text: 'alpha xylophonequartz' },
      { id: 'beta', text: 'beta soup' },
    ])
    const hits = await backend.search({ text: 'xylophonequartz', topK: 5, mode: 'hybrid' })
    expect(hits[0]?.id).toBe('alpha')
    expect(hits[0]?.snippet).toContain('xylophonequartz')
    expect(memory.queries.every((query) => query.mode === 'text')).toBe(true)
    expect(memory.queries.every((query) => query.vector === undefined)).toBe(true)
  })

  it('opens dim 0 with one placeholder vector field and still searches as text', async () => {
    const memory = createMemoryVane()
    const backend = await openBackend(openerFor(memory), 'vault-placeholder', 0)
    await backend.upsert([{ id: 'alpha', text: 'alpha xylophonequartz' }])
    const vectorFields = memory.opened[0]?.schema.fields.filter((field) => field.type === 'vector') ?? []
    expect(vectorFields).toEqual([{ name: 'vec', type: 'vector', dim: 1, metric: 'cosine' }])
    expect(memory.added[0]?.vector).toEqual([0])
    const hits = await backend.search({ text: 'xylophonequartz', topK: 3, mode: 'text' })
    expect(hits[0]?.id).toBe('alpha')
    expect(memory.queries).toEqual([{ text: 'xylophonequartz', topK: 3, mode: 'text' }])
  })

  it('sends a zero vector when dim is set and the document has none', async () => {
    const memory = createMemoryVane()
    const backend = await openBackend(openerFor(memory), 'vault-dim', 4)
    await backend.upsert([{ id: 'alpha', text: 'alpha xylophonequartz' }])
    expect(memory.opened[0]?.schema.fields).toEqual([
      { name: 'text', type: 'text' },
      { name: 'vec', type: 'vector', dim: 4, metric: 'cosine' },
    ])
    expect(memory.added[0]?.vector).toEqual([0, 0, 0, 0])
    const hits = await backend.search({ text: 'xylophonequartz', topK: 3, mode: 'text' })
    expect(hits[0]?.id).toBe('alpha')
  })

  it('rejects an empty vault key', async () => {
    const opener = openerFor()
    await expect(opener.open({ vaultKey: '', dim: 0 })).rejects.toMatchObject({ code: 'escape' })
  })

  it('throws PlatformError and does not open vane when the dictionary cannot be loaded', async () => {
    let called = false
    const factory: VaneFactory = async () => {
      called = true
      throw new Error('factory should not run')
    }
    const opener = createVaneSearchOpener(factory, 'memory', async () => {
      throw new Error('dict missing')
    })
    await expect(opener.open({ vaultKey: 'vault-dict', dim: 0 })).rejects.toBeInstanceOf(PlatformError)
    await expect(opener.open({ vaultKey: 'vault-dict', dim: 0 })).rejects.toMatchObject({ code: 'io' })
    expect(called).toBe(false)
  })

  it('opens the browser index in memory so a stuck OPFS handle cannot abort vault open', async () => {
    const memory = createMemoryVane()
    const session = await vaneWebSearchOpener(memory.factory).open({ vaultKey: 'vault-web', dim: 0 })
    backends.push(session.backend)
    expect(VANE_SNAPSHOT_RESTORE).toBe(true)
    expect(session.capture).toBeNull()
    expect(session.restored).toBe(false)
    expect(memory.workerOpts[0]?.vfs).toBe('memory')
    expect(memory.opened[0]?.vfs).toBe('memory')
  })

  it('searches with the real wasm memory vfs when the worker can start', async () => {
    const opener = createVaneSearchOpener(createVane, 'memory')
    let backend: SearchBackend
    try {
      backend = (await opener.open({ vaultKey: 'wasm-real', dim: 0 })).backend
    } catch (error) {
      if (error instanceof PlatformError) throw error
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
      console.error(`REAL_WASM_UNAVAILABLE: ${message}`)
      return
    }
    backends.push(backend)
    const term = 'xylophonequartz'
    const text = `${'p'.repeat(100)}${term}${'s'.repeat(200)}`
    await backend.upsert([
      { id: 'alpha', text },
      { id: 'beta', text: 'unrelated soup recipe' },
      { id: 'moss', text: '森林地面长满了苔藓和蕨类植物' },
    ])
    const hits = await backend.search({ text: term, topK: 5, mode: 'text' })
    expect(hits[0]?.id).toBe('alpha')
    expect(hits[0]?.snippet).toContain(term)
    const moss = await backend.search({ text: '苔藓', topK: 5, mode: 'text' })
    expect(moss.map((hit) => hit.id)).toContain('moss')
    expect(moss[0]?.snippet?.length).toBeGreaterThan(0)
    const hybrid = await backend.search({ text: term, topK: 5, mode: 'hybrid' })
    expect(hybrid[0]?.id).toBe('alpha')
    await backend.remove(['alpha'])
    expect((await backend.search({ text: term, topK: 5, mode: 'text' })).map((hit) => hit.id)).not.toContain('alpha')
    await backend.close()
    await expect(backend.search({ text: term, topK: 5, mode: 'text' })).rejects.toMatchObject({ code: 'io' })
  }, 20000)

  it('restores a captured snapshot into a new memory session when the worker can start', async () => {
    const opener = vaneWebSearchOpener()
    let first
    try {
      first = await opener.open({ vaultKey: 'wasm-snap-src', dim: 0 })
    } catch (error) {
      if (error instanceof PlatformError) throw error
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
      console.error(`REAL_WASM_UNAVAILABLE: ${message}`)
      return
    }
    backends.push(first.backend)
    const capture = first.capture
    if (!capture) throw new Error('real vane session has no snapshot capture')
    const term = 'xylophonequartz'
    await first.backend.upsert([{ id: 'alpha', text: `${'p'.repeat(40)}${term}${'s'.repeat(40)}` }])
    const snapshot = new Uint8Array(await capture())
    expect(new TextDecoder().decode(snapshot.subarray(0, 9))).toBe('VANE_SNAP')
    await first.backend.close()
    const second = await opener.open({ vaultKey: 'wasm-snap-dst', dim: 0 }, snapshot)
    backends.push(second.backend)
    expect(second.restored).toBe(true)
    const hits = await second.backend.search({ text: term, topK: 5, mode: 'text' })
    expect(hits[0]?.id).toBe('alpha')
    expect(hits[0]?.snippet).toContain(term)
  }, 20000)

  it('ignores a snapshot while restore is off and retries only when a snapshot was used', async () => {
    const opened: Array<{ snapshot?: Uint8Array }> = []
    const closed: string[] = []
    let generation = 0
    const factory: VaneFactory = async () => {
      const id = `worker-${generation}`
      generation += 1
      let alive = true
      const session: VaneSession = {
        async open(_path, opts) {
          opened.push(opts ?? {})
          if (!alive) throw new Error('closed')
        },
        async collection() {
          if (generation === 1) throw new Error('schema mismatch')
          return 1
        },
        async add() { return 0 },
        async flush() { return undefined },
        async search() { return [] },
        async delete() { return 0 },
        async close() {
          alive = false
          closed.push(id)
        },
        async export() { return undefined },
        async readFile() { return new Uint8Array([1, 2, 3]) },
      }
      return session
    }
    const off = createVaneSearchOpener(factory, 'memory', undefined, false)
    const snap = new Uint8Array([9, 9, 9])
    await expect(off.open({ vaultKey: 'vault-off', dim: 0 }, snap)).rejects.toThrow('schema mismatch')
    expect(generation).toBe(1)
    expect(opened).toEqual([{ autoCommit: 'off', persistence: 'persistent' }])
    expect(closed).toEqual(['worker-0'])

    opened.length = 0
    closed.length = 0
    generation = 0
    const on = createVaneSearchOpener(factory, 'memory', undefined, true)
    const session = await on.open({ vaultKey: 'vault-on', dim: 0 }, snap)
    backends.push(session.backend)
    expect(generation).toBe(2)
    expect(opened[0]).toMatchObject({ autoCommit: 'off', persistence: 'persistent', snapshot: snap })
    expect(opened[1]).toEqual({ autoCommit: 'off', persistence: 'persistent' })
    expect(session.restored).toBe(false)
    expect(closed).toEqual(['worker-0'])
    expect(session.capture).not.toBeNull()
    await expect(session.capture?.()).resolves.toEqual(new Uint8Array([1, 2, 3]))
  })
})
