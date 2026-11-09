import { has, resolve } from '@rabjs/react'
import {
  MEMORY_LOG_MAX_LINES,
  parseMemoryEntry,
  parseMemoryIndex,
  rotateLogLines,
  serializeMemoryEntry,
  serializeMemoryIndex,
  vaultStorageKey,
  type MemoryEntry,
  type MemoryIndex,
  type MemoryIndexEntry,
  type MemoryScope,
  type MemoryToolHost,
} from '@stride/core'
import type { AppDataStore } from '@stride/platform'
import { resolveAppDataStore } from '../platform/app-data'
import { SettingsService } from '../settings/settings.service'
import type { VaultService } from '../vault/vault.service'

type LockManagerLike = { request<T>(name: string, callback: () => Promise<T>): Promise<T> }

function locksApi(): LockManagerLike | undefined {
  if (typeof navigator === 'undefined') return undefined
  return (navigator as Navigator & { locks?: LockManagerLike }).locks
}

/** Cross-tab / cross-window guard; the in-process queue below does the rest. */
async function withMemoryLock<T>(scope: MemoryScope, job: () => Promise<T>): Promise<T> {
  const locks = locksApi()
  if (!locks) return job()
  return locks.request(`stride-memory-${scope}`, job)
}

/**
 * Re-read reconciliation for index writes (design doc §5.6). The incoming
 * snapshot is authoritative for the ids it carries. A stored entry missing
 * from the incoming snapshot is dropped when this host previously served it
 * to the writer (a deliberate removal, e.g. memory_forget) and carried over
 * otherwise (a concurrent addition the writer could not have seen).
 * `served` is the id set from the host's latest readIndex of the scope, or
 * null when nothing was served yet. Residual cross-instance
 * last-writer-wins is a known limitation, cleaned up by curation.
 */
export function mergeMemoryIndexes(
  stored: MemoryIndex | null,
  incoming: MemoryIndex,
  served: ReadonlySet<string> | null,
): MemoryIndex {
  if (!stored) return incoming
  const entries: MemoryIndexEntry[] = []
  for (const entry of stored.entries) {
    const missingFromIncoming = !incoming.entries.some((next) => next.id === entry.id)
    if (missingFromIncoming && (served === null || !served.has(entry.id))) entries.push(entry)
  }
  entries.push(...incoming.entries)
  return {
    format: 1,
    updatedAt: incoming.updatedAt > stored.updatedAt ? incoming.updatedAt : stored.updatedAt,
    distillCount: Math.max(stored.distillCount, incoming.distillCount),
    entries,
  }
}

// One in-process write queue shared by every host instance (design §5.6):
// chat turns, distillation, and curation must never interleave index writes.
// Web Locks cover the cross-tab case on top.
let writeChain: Promise<void> = Promise.resolve()

function makeMemoryHost(projectKey: () => string | null): MemoryToolHost {
  // Entry ids this host last served from readIndex, per scope: the baseline
  // for mergeMemoryIndexes' removal-vs-concurrent-add decision.
  const served: Record<MemoryScope, Set<string> | null> = { project: null, global: null }

  const store = async (): Promise<AppDataStore> => (await resolveAppDataStore()).store

  const base = (scope: MemoryScope): string | null => {
    if (scope === 'global') return 'memory/_global'
    const key = projectKey()
    return key ? `memory/${key}` : null
  }

  const requireBase = (scope: MemoryScope): string => {
    const root = base(scope)
    if (!root) throw new Error('Open a vault first')
    return root
  }

  const enqueue = <T>(scope: MemoryScope, job: (store: AppDataStore) => Promise<T>): Promise<T> => {
    const run = writeChain.then(() => withMemoryLock(scope, async () => job(await store())))
    writeChain = run.then(() => undefined, () => undefined)
    return run
  }

  return {
    async readIndex(scope) {
      const root = base(scope)
      if (!root) return null
      const text = await (await store()).readText(`${root}/index.json`)
      const index = text === null ? null : parseMemoryIndex(text)
      served[scope] = new Set((index?.entries ?? []).map((entry) => entry.id))
      return index
    },
    async writeIndex(scope, index) {
      await enqueue(scope, async (store) => {
        const root = requireBase(scope)
        const text = await store.readText(`${root}/index.json`)
        const stored = text === null ? null : parseMemoryIndex(text)
        await store.writeText(`${root}/index.json`, serializeMemoryIndex(mergeMemoryIndexes(stored, index, served[scope])))
      })
    },
    async readEntry(scope, id) {
      const root = base(scope)
      if (!root) return null
      const text = await (await store()).readText(`${root}/entries/${id}.json`)
      return text === null ? null : parseMemoryEntry(text)
    },
    async writeEntry(scope, entry) {
      await enqueue(scope, async (store) => {
        const root = requireBase(scope)
        await store.writeText(`${root}/entries/${entry.id}.json`, serializeMemoryEntry(entry))
      })
    },
    async appendLog(scope, line) {
      await enqueue(scope, async (store) => {
        const root = requireBase(scope)
        const path = `${root}/log.jsonl`
        const text = await store.readText(path)
        const lines = text ? text.split('\n').filter((item) => item !== '') : []
        lines.push(line)
        const kept = lines.length > MEMORY_LOG_MAX_LINES ? rotateLogLines(lines) : lines
        await store.writeText(path, `${kept.join('\n')}\n`)
      })
    },
    secretValues() {
      if (!has(SettingsService)) return []
      return resolve(SettingsService).configuredSecretValues()
    },
  }
}

/**
 * MemoryToolHost over the AppDataStore port. Project scope lives under
 * `memory/<vault-key>/`, global scope under `memory/_global/`. All writes go
 * through one serial queue and (when available) a Web Lock per scope.
 */
export function chatMemoryHost(vault: VaultService): MemoryToolHost {
  return makeMemoryHost(() => {
    const id = vault.activeVaultId
    return id ? vaultStorageKey(id) : null
  })
}

/**
 * Host bound to a fixed vault key. Background memory work (distillation,
 * curation) must keep writing to the vault the session belongs to even after
 * the user switches vaults.
 */
export function chatMemoryHostKeyed(vaultKey: string): MemoryToolHost {
  return makeMemoryHost(() => vaultKey || null)
}
