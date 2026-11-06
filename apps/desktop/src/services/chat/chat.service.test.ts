import { has, register, resolve } from '@rabjs/react'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { MemoryAppDataStore } from '@stride/platform'
import {
  DISTILL_MEMORY_PROMPT,
  emptyMemoryIndex,
  newSessionId,
  parseMemoryIndex,
  parseSession,
  parseSessionMeta,
  serializeMemoryEntry,
  serializeMemoryIndex,
  serializeSession,
  serializeSessionMeta,
  upsertIndexEntry,
  vaultStorageKey,
  type AgentUsage,
  type ChatSessionMeta,
  type MemoryIndexEntry,
} from '@stride/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CHAT_HISTORY_LOAD_ERROR, ChatService } from './chat.service'
import { blankChatSession, ChatTurnError, playChatTurn } from './chat-turn'
import { resetAppDataStore, setAppDataStore } from '../platform/app-data'
import { SettingsService } from '../settings/settings.service'
import { VaultService } from '../vault/vault.service'

vi.mock('./chat-turn', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./chat-turn')>()
  return { ...actual, playChatTurn: vi.fn() }
})

vi.mock('./chat-turn', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./chat-turn')>()
  return { ...actual, playChatTurn: vi.fn() }
})

const mockedTurn = vi.mocked(playChatTurn)

let store: MemoryAppDataStore

function turnUsage(): AgentUsage {
  return { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, costTotal: 0 }
}

function userMessage(text: string): AgentMessage {
  return { role: 'user', content: text, timestamp: 1 } as AgentMessage
}

function assistantMessage(text: string): AgentMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    timestamp: 2,
  } as unknown as AgentMessage
}

function turnResult(transcript: AgentMessage[], overrides: Partial<Awaited<ReturnType<typeof playChatTurn>>> = {}) {
  return {
    text: 'answer',
    usage: turnUsage(),
    aborted: false,
    turnLimit: false,
    transcript,
    ...overrides,
  }
}

function sampleMeta(overrides: Partial<ChatSessionMeta> = {}): ChatSessionMeta {
  return {
    format: 1,
    id: newSessionId(),
    vaultKey: vaultStorageKey('vault-1'),
    vaultLabel: 'vault',
    title: 'Stored',
    createdAt: '2026-11-06T08:00:00.000Z',
    updatedAt: '2026-11-06T08:12:31.000Z',
    status: 'active',
    modelId: 'cfg1',
    messageCount: 2,
    usage: turnUsage(),
    ...overrides,
  }
}

function setup() {
  if (!has(VaultService)) register(VaultService)
  if (!has(SettingsService)) register(SettingsService)
  if (!has(ChatService)) register(ChatService)
  const vault = resolve(VaultService)
  const settings = resolve(SettingsService)
  const chat = resolve(ChatService)
  vault.activeVaultId = 'vault-1'
  settings.form = {
    ...settings.form,
    // Memory is off by default here; the memory integration tests opt in.
    agent: { maxTurns: 200, memoryEnabled: false, memoryModelId: '' },
    llmConfigs: [
      { id: 'cfg1', name: 'Primary', provider: 'openai', model: 'gpt-4o-mini', baseUrl: 'https://example.test/v1', keyMask: '••••1234', isDefault: true },
      { id: 'cfg2', name: 'Backup', provider: 'openai', model: 'gpt-4o', baseUrl: 'https://example.test/v1', keyMask: '••••5678', isDefault: false },
    ],
  }
  Object.assign(settings, { memoryLlmKeys: { cfg1: 'sk-one', cfg2: 'sk-two' } })
  return { vault, settings, chat }
}

function enableMemory(settings: SettingsService) {
  settings.form = {
    ...settings.form,
    agent: { ...settings.form.agent, memoryEnabled: true, memoryModelId: '' },
  }
}

function resetChat(chat: ChatService) {
  chat.draft = ''
  chat.error = ''
  chat.running = false
  chat.modelId = ''
  chat.session = blankChatSession(newSessionId())
  chat.metas = []
  chat.historyLoaded = false
  chat.historyOpen = false
  chat.storagePersistent = null
  chat.memoryBusy = false
  chat.memoryError = ''
  chat.resetMemoryWork()
  Object.assign(chat, { vaultKeyLoaded: null, controller: null, writeChain: Promise.resolve(), loadTicket: 0 })
}

describe('ChatService persistence', () => {
  beforeEach(() => {
    store = new MemoryAppDataStore()
    setAppDataStore({ store, persistent: true })
    mockedTurn.mockReset()
  })

  afterEach(() => {
    resetAppDataStore()
    resetChat(resolve(ChatService))
    resolve(VaultService).activeVaultId = ''
  })

  it('persists meta and body after a turn and locks the session model', async () => {
    const { chat } = setup()
    const transcript = [userMessage('hello'), assistantMessage('answer')]
    mockedTurn.mockResolvedValue(turnResult(transcript))
    chat.draft = 'hello'
    await chat.send()

    expect(mockedTurn).toHaveBeenCalledTimes(1)
    expect(mockedTurn.mock.calls[0]?.[0].history).toEqual([])
    expect(chat.error).toBe('')
    expect(chat.session.transcript).toEqual(transcript)
    expect(chat.session.modelId).toBe('cfg1')

    const key = vaultStorageKey('vault-1')
    const metaText = await store.readText(`chats/${key}/${chat.session.id}.meta.json`)
    const bodyText = await store.readText(`chats/${key}/${chat.session.id}.json`)
    expect(metaText).not.toBeNull()
    expect(bodyText).not.toBeNull()
    const meta = parseSessionMeta(metaText!)!
    expect(meta.status).toBe('active')
    expect(meta.messageCount).toBe(2)
    expect(meta.modelId).toBe('cfg1')
    expect(meta.vaultKey).toBe(key)
    expect(meta.usage.totalTokens).toBe(2)
    const body = parseSession(bodyText!)!
    expect(body.transcript.map((message) => message.role)).toEqual(['user', 'assistant'])
    expect(body.messages).toHaveLength(2)
    expect(body.memory).toEqual({ distilledUpTo: 0, lastDistillAt: '' })
    // The in-memory History list reflects the write without a reload.
    expect(chat.metas.map((item) => item.id)).toEqual([chat.session.id])
  })

  it('passes the previous transcript as history on the next turn', async () => {
    const { chat } = setup()
    const first = [userMessage('one'), assistantMessage('answer one')]
    const second = [...first, userMessage('two'), assistantMessage('answer two')]
    mockedTurn.mockResolvedValueOnce(turnResult(first))
    chat.draft = 'one'
    await chat.send()
    mockedTurn.mockResolvedValueOnce(turnResult(second))
    chat.draft = 'two'
    await chat.send()

    expect(mockedTurn).toHaveBeenCalledTimes(2)
    expect(mockedTurn.mock.calls[1]?.[0].history).toEqual(first)
    expect(chat.session.transcript).toEqual(second)
    // Usage accumulates across turns in the meta file.
    const key = vaultStorageKey('vault-1')
    const meta = parseSessionMeta((await store.readText(`chats/${key}/${chat.session.id}.meta.json`))!)!
    expect(meta.usage.totalTokens).toBe(4)
  })

  it('persists the transcript attached to a ChatTurnError', async () => {
    const { chat } = setup()
    const transcript = [userMessage('go'), assistantMessage('partial')]
    mockedTurn.mockRejectedValue(new ChatTurnError('provider down', transcript))
    chat.draft = 'go'
    await chat.send()

    expect(chat.error).toBe('provider down')
    expect(chat.session.transcript).toEqual(transcript)
    const key = vaultStorageKey('vault-1')
    const body = parseSession((await store.readText(`chats/${key}/${chat.session.id}.json`))!)!
    expect(body.transcript.map((message) => message.role)).toEqual(['user', 'assistant'])
  })

  it('persists after an aborted turn', async () => {
    const { chat } = setup()
    const transcript = [userMessage('go'), assistantMessage('partial')]
    mockedTurn.mockResolvedValue(turnResult(transcript, { aborted: true }))
    chat.draft = 'go'
    const pending = chat.send()
    chat.abort()
    await pending

    expect(chat.error).toBe('')
    const key = vaultStorageKey('vault-1')
    const meta = parseSessionMeta((await store.readText(`chats/${key}/${chat.session.id}.meta.json`))!)!
    expect(meta.status).toBe('active')
    expect(meta.messageCount).toBe(2)
  })

  it('close persists the session as closed and resets to a blank one', async () => {
    const { chat } = setup()
    mockedTurn.mockResolvedValue(turnResult([userMessage('go'), assistantMessage('answer')]))
    chat.draft = 'go'
    await chat.send()
    const closedId = chat.session.id

    await chat.close()
    expect(chat.session.id).not.toBe(closedId)
    expect(chat.session.messages).toEqual([])
    expect(chat.session.status).toBe('active')

    const key = vaultStorageKey('vault-1')
    const meta = parseSessionMeta((await store.readText(`chats/${key}/${closedId}.meta.json`))!)!
    expect(meta.status).toBe('closed')
    expect(chat.metas.find((item) => item.id === closedId)?.status).toBe('closed')

    // Closing a blank session writes nothing.
    const before = await store.list('chats/')
    await chat.close()
    expect(await store.list('chats/')).toEqual(before)
  })

  it('never persists a blank session', async () => {
    const { chat } = setup()
    await chat.ensureLoaded()
    chat.newSession()
    await chat.close()
    expect(await store.list('chats/')).toEqual([])
  })

  it('does not persist without an active vault', async () => {
    const { chat, vault } = setup()
    vault.activeVaultId = ''
    mockedTurn.mockResolvedValue(turnResult([userMessage('go'), assistantMessage('answer')]))
    chat.draft = 'go'
    await chat.send()
    expect(mockedTurn).toHaveBeenCalledTimes(1)
    expect(await store.list('chats/')).toEqual([])
  })

  it('deleteSession removes both files and resets a staged session', async () => {
    const { chat } = setup()
    mockedTurn.mockResolvedValue(turnResult([userMessage('go'), assistantMessage('answer')]))
    chat.draft = 'go'
    await chat.send()
    const id = chat.session.id

    await chat.deleteSession(id)
    const key = vaultStorageKey('vault-1')
    expect(await store.readText(`chats/${key}/${id}.meta.json`)).toBeNull()
    expect(await store.readText(`chats/${key}/${id}.json`)).toBeNull()
    expect(chat.metas).toEqual([])
    expect(chat.session.id).not.toBe(id)
    expect(chat.session.messages).toEqual([])
  })

  it('openFromHistory restores messages, transcript, and model, then continues the session', async () => {
    const { chat } = setup()
    const first = [userMessage('earlier'), assistantMessage('answer')]
    mockedTurn.mockResolvedValueOnce(turnResult(first))
    chat.draft = 'earlier'
    await chat.send()
    const id = chat.session.id
    chat.newSession()
    expect(chat.session.messages).toEqual([])

    await chat.openFromHistory(id)
    expect(chat.session.id).toBe(id)
    expect(chat.session.messages).toHaveLength(2)
    expect(chat.session.transcript).toEqual(first)
    expect(chat.session.modelId).toBe('cfg1')

    const second = [...first, userMessage('next'), assistantMessage('again')]
    mockedTurn.mockResolvedValueOnce(turnResult(second))
    chat.draft = 'next'
    await chat.send()
    expect(mockedTurn.mock.calls[1]?.[0].history).toEqual(first)
    expect(chat.session.transcript).toEqual(second)
  })

  it('surfaces a translated error when the stored session cannot be parsed', async () => {
    const { chat } = setup()
    await chat.ensureLoaded()
    const key = vaultStorageKey('vault-1')
    await store.writeText(`chats/${key}/ses_broken.json`, 'not json')
    await chat.openFromHistory('ses_broken')
    expect(chat.error).toBe(CHAT_HISTORY_LOAD_ERROR)
  })

  it('skips corrupt meta files while loading the History list', async () => {
    const { chat } = setup()
    const key = vaultStorageKey('vault-1')
    const older = sampleMeta({ id: 'ses_old', title: 'Older', updatedAt: '2026-11-05T08:00:00.000Z' })
    const newer = sampleMeta({ id: 'ses_new', title: 'Newer', updatedAt: '2026-11-06T09:00:00.000Z' })
    await store.writeText(`chats/${key}/ses_old.meta.json`, serializeSessionMeta(older))
    await store.writeText(`chats/${key}/ses_new.meta.json`, serializeSessionMeta(newer))
    await store.writeText(`chats/${key}/ses_garbage.meta.json`, '{oops')
    await store.writeText(`chats/${key}/ses_new.json`, '{}')

    await chat.ensureLoaded()
    expect(chat.historyLoaded).toBe(true)
    // Sorted by updatedAt, newest first; the corrupt file is skipped.
    expect(chat.metas.map((item) => item.id)).toEqual(['ses_new', 'ses_old'])
  })

  it('keeps using the locked model while its config exists', async () => {
    const { chat } = setup()
    mockedTurn.mockResolvedValue(turnResult([userMessage('go'), assistantMessage('answer')]))
    chat.draft = 'one'
    await chat.send()
    chat.setModel('cfg2')
    chat.draft = 'two'
    await chat.send()

    expect(mockedTurn).toHaveBeenCalledTimes(2)
    expect(mockedTurn.mock.calls[1]?.[0].apiKey).toBe('sk-one')
    expect(chat.session.modelId).toBe('cfg1')
  })

  it('falls back to the composer model when the locked config is gone', async () => {
    const { chat, settings } = setup()
    mockedTurn.mockResolvedValue(turnResult([userMessage('go'), assistantMessage('answer')]))
    chat.draft = 'one'
    await chat.send()
    expect(chat.session.modelId).toBe('cfg1')
    settings.form = {
      ...settings.form,
      llmConfigs: [
        { id: 'cfg2', name: 'Backup', provider: 'openai', model: 'gpt-4o', baseUrl: 'https://example.test/v1', keyMask: '••••5678', isDefault: true },
      ],
    }
    chat.draft = 'two'
    await chat.send()
    expect(mockedTurn.mock.calls[1]?.[0].apiKey).toBe('sk-two')
  })

  it('resets the session area and reloads when the vault changes', async () => {
    const { chat, vault } = setup()
    mockedTurn.mockResolvedValue(turnResult([userMessage('go'), assistantMessage('answer')]))
    chat.draft = 'go'
    await chat.send()
    await chat.ensureLoaded()
    expect(chat.metas).toHaveLength(1)

    vault.activeVaultId = 'vault-2'
    await chat.ensureLoaded()
    expect(chat.session.messages).toEqual([])
    expect(chat.metas).toEqual([])
    // Vault-one files are untouched.
    expect(await store.list(`chats/${vaultStorageKey('vault-1')}/`)).not.toEqual([])

    // Switching back restores the list, not the staged session.
    vault.activeVaultId = 'vault-1'
    await chat.ensureLoaded()
    expect(chat.session.messages).toEqual([])
    expect(chat.metas).toHaveLength(1)
  })
})

function memoryIndexEntry(partial: Partial<MemoryIndexEntry> & { id: string }): MemoryIndexEntry {
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

describe('ChatService memory integration', () => {
  beforeEach(() => {
    store = new MemoryAppDataStore()
    setAppDataStore({ store, persistent: true })
    mockedTurn.mockReset()
  })

  afterEach(() => {
    resetAppDataStore()
    resetChat(resolve(ChatService))
    resolve(VaultService).activeVaultId = ''
  })

  it('mounts the memory tools and injects the two-scope index into the system prompt', async () => {
    const { chat, settings } = setup()
    enableMemory(settings)
    const key = vaultStorageKey('vault-1')
    const project = upsertIndexEntry(
      emptyMemoryIndex('2026-11-06T09:00:00.000Z'),
      memoryIndexEntry({ id: 'mem_p', title: 'Reply language', summary: 'Answer in Chinese' }),
    )
    const globalIndex = upsertIndexEntry(
      emptyMemoryIndex('2026-11-06T09:00:00.000Z'),
      memoryIndexEntry({ id: 'mem_g', title: 'Style', summary: 'Terse answers' }),
    )
    await store.writeText(`memory/${key}/index.json`, serializeMemoryIndex(project))
    await store.writeText('memory/_global/index.json', serializeMemoryIndex(globalIndex))
    mockedTurn.mockResolvedValue(turnResult([userMessage('go'), assistantMessage('answer')]))
    chat.draft = 'go'
    await chat.send()

    const args = mockedTurn.mock.calls[0]?.[0]
    const names = (args?.tools ?? []).map((tool) => tool.name)
    expect(names).toContain('memory_read')
    expect(names).toContain('memory_write')
    expect(names).toContain('memory_forget')
    expect(names).toContain('read_note')
    expect(args?.systemPrompt).toContain('## Long-term memory index')
    expect(args?.systemPrompt).toContain('Answer in Chinese')
    expect(args?.systemPrompt).toContain('Terse answers')
  })

  it('mounts no memory tools and no memory prompt when memory is disabled', async () => {
    const { chat } = setup()
    mockedTurn.mockResolvedValue(turnResult([userMessage('go'), assistantMessage('answer')]))
    chat.draft = 'go'
    await chat.send()

    const args = mockedTurn.mock.calls[0]?.[0]
    const names = (args?.tools ?? []).map((tool) => tool.name)
    expect(names).not.toContain('memory_read')
    expect(args?.systemPrompt).not.toContain('memory_read')
    expect(args?.systemPrompt).not.toContain('Long-term memory index')
  })

  it('lists active memories per scope for the panel and reads entry content lazily', async () => {
    const { chat } = setup()
    const key = vaultStorageKey('vault-1')
    const project = upsertIndexEntry(
      upsertIndexEntry(
        emptyMemoryIndex('2026-11-06T09:00:00.000Z'),
        memoryIndexEntry({ id: 'mem_old', updatedAt: '2026-11-01T09:00:00.000Z' }),
      ),
      memoryIndexEntry({ id: 'mem_new', updatedAt: '2026-11-05T09:00:00.000Z' }),
    )
    const withArchived = upsertIndexEntry(project, memoryIndexEntry({ id: 'mem_arch', status: 'archived' }))
    const globalIndex = upsertIndexEntry(
      emptyMemoryIndex('2026-11-06T09:00:00.000Z'),
      memoryIndexEntry({ id: 'mem_g' }),
    )
    await store.writeText(`memory/${key}/index.json`, serializeMemoryIndex(withArchived))
    await store.writeText('memory/_global/index.json', serializeMemoryIndex(globalIndex))
    await store.writeText(
      `memory/${key}/entries/mem_new.json`,
      serializeMemoryEntry({
        format: 1,
        id: 'mem_new',
        kind: 'fact',
        title: 'mem_new',
        content: 'full content of mem_new',
        tags: [],
        createdAt: '2026-11-01T09:00:00.000Z',
        updatedAt: '2026-11-05T09:00:00.000Z',
        source: { sessionId: '', noteIds: [] },
        status: 'active',
      }),
    )

    const lists = await chat.listMemories()
    // Active only, newest first; archived entries stay out of the panel.
    expect(lists.project.map((entry) => entry.id)).toEqual(['mem_new', 'mem_old'])
    expect(lists.global.map((entry) => entry.id)).toEqual(['mem_g'])

    const detail = await chat.readMemory('project', 'mem_new')
    expect(detail?.content).toBe('full content of mem_new')
    expect(await chat.readMemory('project', 'mem_missing')).toBeNull()
  })

  it('distills the session on close and advances the cursor and counter', async () => {
    const { chat, settings } = setup()
    enableMemory(settings)
    const transcript = [userMessage('go'), assistantMessage('answer')]
    mockedTurn.mockResolvedValue(turnResult(transcript))
    chat.draft = 'go'
    await chat.send()
    const id = chat.session.id
    expect(mockedTurn).toHaveBeenCalledTimes(1)

    await chat.close()
    await chat.whenMemorySettled()

    // One extra headless call: the distillation pass.
    expect(mockedTurn).toHaveBeenCalledTimes(2)
    const distillArgs = mockedTurn.mock.calls[1]?.[0]
    expect(distillArgs?.systemPrompt).toContain(DISTILL_MEMORY_PROMPT)
    expect(distillArgs?.prompt).toBe(JSON.stringify(transcript))
    expect((distillArgs?.tools ?? []).map((tool) => tool.name)).toEqual([
      'memory_read',
      'memory_write',
      'memory_forget',
    ])

    const key = vaultStorageKey('vault-1')
    const body = parseSession((await store.readText(`chats/${key}/${id}.json`))!)!
    expect(body.memory.distilledUpTo).toBe(transcript.length)
    expect(body.memory.lastDistillAt).not.toBe('')
    const index = parseMemoryIndex((await store.readText(`memory/${key}/index.json`))!)!
    expect(index.distillCount).toBe(1)
  })

  it('does not distill on close when memory is disabled', async () => {
    const { chat } = setup()
    mockedTurn.mockResolvedValue(turnResult([userMessage('go'), assistantMessage('answer')]))
    chat.draft = 'go'
    await chat.send()
    await chat.close()
    await chat.whenMemorySettled()
    expect(mockedTurn).toHaveBeenCalledTimes(1)
    const key = vaultStorageKey('vault-1')
    expect(await store.readText(`memory/${key}/index.json`)).toBeNull()
  })

  it('skips distillation silently when no memory model is configured', async () => {
    const { chat, settings } = setup()
    enableMemory(settings)
    mockedTurn.mockResolvedValue(turnResult([userMessage('go'), assistantMessage('answer')]))
    chat.draft = 'go'
    await chat.send()
    const id = chat.session.id
    // The turn succeeded with keys; the memory model is gone by close time.
    Object.assign(settings, { memoryLlmKeys: {} })
    await chat.close()
    await chat.whenMemorySettled()

    expect(mockedTurn).toHaveBeenCalledTimes(1)
    expect(chat.memoryError).toBe('')
    const key = vaultStorageKey('vault-1')
    const body = parseSession((await store.readText(`chats/${key}/${id}.json`))!)!
    expect(body.memory.distilledUpTo).toBe(0)
  })

  it('catches up dirty sessions on load (startup scan)', async () => {
    const { chat, settings } = setup()
    enableMemory(settings)
    const key = vaultStorageKey('vault-1')
    const transcript = [userMessage('old'), assistantMessage('older answer')]
    const id = 'ses_dirty'
    await store.writeText(`chats/${key}/${id}.meta.json`, serializeSessionMeta(sampleMeta({ id })))
    await store.writeText(`chats/${key}/${id}.json`, serializeSession({
      format: 1,
      id,
      messages: [],
      transcript,
      memory: { distilledUpTo: 0, lastDistillAt: '' },
    }))
    mockedTurn.mockResolvedValue(turnResult(transcript))

    await chat.ensureLoaded()
    await chat.whenMemorySettled()

    expect(mockedTurn).toHaveBeenCalledTimes(1)
    expect(mockedTurn.mock.calls[0]?.[0].systemPrompt).toContain(DISTILL_MEMORY_PROMPT)
    const body = parseSession((await store.readText(`chats/${key}/${id}.json`))!)!
    expect(body.memory.distilledUpTo).toBe(transcript.length)
  })

  it('distillMemoryNow persists and distills the staged session', async () => {
    const { chat, settings } = setup()
    enableMemory(settings)
    const transcript = [userMessage('go'), assistantMessage('answer')]
    mockedTurn.mockResolvedValue(turnResult(transcript))
    chat.draft = 'go'
    await chat.send()
    const id = chat.session.id
    expect(mockedTurn).toHaveBeenCalledTimes(1)

    await chat.distillMemoryNow()
    await chat.whenMemorySettled()
    expect(mockedTurn).toHaveBeenCalledTimes(2)
    const key = vaultStorageKey('vault-1')
    const body = parseSession((await store.readText(`chats/${key}/${id}.json`))!)!
    expect(body.memory.distilledUpTo).toBe(transcript.length)
    // The staged session mirrors the advanced cursor.
    expect(chat.session.memory.distilledUpTo).toBe(transcript.length)
  })
})
