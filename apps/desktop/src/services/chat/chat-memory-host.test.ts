import { afterEach, describe, expect, it } from 'vitest'
import { has, register, resolve } from '@rabjs/react'
import { MemoryAppDataStore } from '@stride/platform'
import {
  MEMORY_LOG_MAX_LINES,
  emptyMemoryIndex,
  upsertIndexEntry,
  vaultStorageKey,
  type MemoryEntry,
  type MemoryIndexEntry,
} from '@stride/core'
import { resetAppDataStore, setAppDataStore } from '../platform/app-data'
import { chatMemoryHost } from './chat-memory-host'
import { SettingsService } from '../settings/settings.service'
import type { VaultService } from '../vault/vault.service'

function makeVault(activeVaultId: string): VaultService {
  return { activeVaultId } as unknown as VaultService
}

function indexEntry(partial: Partial<MemoryIndexEntry> & { id: string }): MemoryIndexEntry {
  return {
    kind: 'fact',
    title: partial.id,
    summary: `summary of ${partial.id}`,
    tags: [],
    status: 'active',
    updatedAt: '2026-11-06T09:00:00.000Z',
    sessionId: '',
    supersedes: [],
    ...partial,
  }
}

function memoryEntry(partial: Partial<MemoryEntry> & { id: string }): MemoryEntry {
  return {
    format: 1,
    kind: 'fact',
    title: partial.id,
    content: `content of ${partial.id}`,
    tags: [],
    createdAt: '2026-11-06T09:00:00.000Z',
    updatedAt: '2026-11-06T09:00:00.000Z',
    source: { sessionId: '', noteIds: [] },
    status: 'active',
    ...partial,
  }
}

describe('chatMemoryHost', () => {
  let store: MemoryAppDataStore

  afterEach(() => {
    resetAppDataStore()
  })

  function setup(vaultId = 'vault-a') {
    store = new MemoryAppDataStore()
    setAppDataStore({ store, persistent: false })
    return chatMemoryHost(makeVault(vaultId))
  }

  it('maps project scope to memory/<vault-key>/ and global to memory/_global/', async () => {
    const host = setup('vault-a')
    const index = upsertIndexEntry(emptyMemoryIndex('2026-11-06T09:00:00.000Z'), indexEntry({ id: 'mem_p' }))
    await host.writeIndex('project', index)
    await host.writeEntry('global', memoryEntry({ id: 'mem_g' }))
    const key = vaultStorageKey('vault-a')
    expect(await store.readText(`memory/${key}/index.json`)).not.toBeNull()
    expect(await store.readText('memory/_global/entries/mem_g.json')).not.toBeNull()
    expect((await host.readIndex('project'))?.entries.map((entry) => entry.id)).toEqual(['mem_p'])
    expect((await host.readEntry('global', 'mem_g'))?.id).toBe('mem_g')
  })

  it('reads project scope as null and rejects project writes without an active vault', async () => {
    const host = setup('')
    expect(await host.readIndex('project')).toBeNull()
    expect(await host.readEntry('project', 'mem_a')).toBeNull()
    await expect(host.writeIndex('project', emptyMemoryIndex())).rejects.toThrow('Open a vault first')
    await expect(host.writeEntry('project', memoryEntry({ id: 'mem_a' }))).rejects.toThrow('Open a vault first')
    // Global scope stays available.
    await host.writeIndex('global', emptyMemoryIndex('2026-11-06T09:00:00.000Z'))
    expect(await store.readText('memory/_global/index.json')).not.toBeNull()
  })

  it('serializes concurrent index writes so no update is lost', async () => {
    const host = setup()
    const base = upsertIndexEntry(emptyMemoryIndex('2026-11-06T09:00:00.000Z'), indexEntry({ id: 'mem_x' }))
    await host.writeIndex('global', base)
    // Two writers start from the same stale base; both entries must survive.
    const writeA = upsertIndexEntry(base, indexEntry({ id: 'mem_a', updatedAt: '2026-11-06T09:01:00.000Z' }))
    const writeB = upsertIndexEntry(base, indexEntry({ id: 'mem_b', updatedAt: '2026-11-06T09:02:00.000Z' }))
    await Promise.all([host.writeIndex('global', writeA), host.writeIndex('global', writeB)])
    const final = await host.readIndex('global')
    expect(final?.entries.map((entry) => entry.id).sort()).toEqual(['mem_a', 'mem_b', 'mem_x'])
  })

  it('lets a forget-style write drop entries it saw when reading', async () => {
    const host = setup()
    const stale = indexEntry({ id: 'mem_stale', updatedAt: '2020-01-01T00:00:00.000Z' })
    await host.writeIndex('global', upsertIndexEntry(emptyMemoryIndex('2020-01-01T00:00:00.000Z'), stale))
    const index = await host.readIndex('global')
    const removed = { ...index!, updatedAt: '2026-11-06T09:00:00.000Z', entries: [] }
    await host.writeIndex('global', removed)
    expect((await host.readIndex('global'))?.entries).toEqual([])
  })

  it('rotates the log to the newest half past the cap', async () => {
    const host = setup()
    for (let index = 0; index < MEMORY_LOG_MAX_LINES + 1; index += 1) {
      await host.appendLog('global', `line-${index}`)
    }
    const text = await store.readText('memory/_global/log.jsonl')
    const lines = (text ?? '').split('\n').filter((line) => line !== '')
    expect(lines).toHaveLength(MEMORY_LOG_MAX_LINES / 2)
    expect(lines[lines.length - 1]).toBe(`line-${MEMORY_LOG_MAX_LINES}`)
  })

  it('collects every configured key for secret scanning', () => {
    if (!has(SettingsService)) register(SettingsService)
    const settings = resolve(SettingsService)
    const internals = settings as unknown as {
      memoryLlmKeys: Record<string, string>
      memoryEmbeddingKey: string
    }
    const previousKeys = internals.memoryLlmKeys
    const previousEmbedding = internals.memoryEmbeddingKey
    const previousForm = settings.form
    internals.memoryLlmKeys = { cfg_a: 'sk-live-a', cfg_b: '' }
    internals.memoryEmbeddingKey = 'emb-key-1'
    settings.form = {
      ...settings.form,
      llmConfigs: [
        { id: 'cfg_a', name: 'A', provider: 'openai', model: 'gpt-4o-mini', baseUrl: '', keyMask: '', isDefault: true },
        { id: 'cfg_b', name: 'B', provider: 'openai', model: 'gpt-4o-mini', baseUrl: '', keyMask: '', isDefault: false },
      ],
    }
    try {
      const host = chatMemoryHost(makeVault('vault-a'))
      expect(host.secretValues()).toEqual(['sk-live-a', 'emb-key-1'])
    } finally {
      internals.memoryLlmKeys = previousKeys
      internals.memoryEmbeddingKey = previousEmbedding
      settings.form = previousForm
    }
  })

  it('keeps a shorter llm key ahead of a longer embedding key', () => {
    if (!has(SettingsService)) register(SettingsService)
    const settings = resolve(SettingsService)
    const internals = settings as unknown as {
      memoryLlmKeys: Record<string, string>
      memoryEmbeddingKey: string
    }
    const previousKeys = internals.memoryLlmKeys
    const previousEmbedding = internals.memoryEmbeddingKey
    const previousForm = settings.form
    internals.memoryLlmKeys = { cfg_a: 'sk-short' }
    internals.memoryEmbeddingKey = 'sk-short-and-more'
    settings.form = {
      ...settings.form,
      llmConfigs: [
        { id: 'cfg_a', name: 'A', provider: 'openai', model: 'gpt-4o-mini', baseUrl: '', keyMask: '', isDefault: true },
      ],
    }
    try {
      const host = chatMemoryHost(makeVault('vault-a'))
      expect(settings.configuredSecretValues()).toEqual(['sk-short', 'sk-short-and-more'])
      expect(host.secretValues()).toEqual(['sk-short', 'sk-short-and-more'])
    } finally {
      internals.memoryLlmKeys = previousKeys
      internals.memoryEmbeddingKey = previousEmbedding
      settings.form = previousForm
    }
  })
})
