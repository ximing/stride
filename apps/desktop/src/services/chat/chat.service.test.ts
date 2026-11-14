import { has, register, resolve } from '@rabjs/react'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { MemoryAppDataStore, MemoryFileSystem } from '@stride/platform'
import {
  createNote,
  DISTILL_MEMORY_PROMPT,
  emptyMemoryIndex,
  newSessionId,
  notePath,
  parseMemoryIndex,
  parseSession,
  parseSessionMeta,
  serializeMemoryEntry,
  serializeMemoryIndex,
  serializeNote,
  serializeSession,
  serializeSessionMeta,
  upsertIndexEntry,
  vaultStorageKey,
  type AgentUsage,
  type ChatSessionMeta,
  type MemoryIndexEntry,
  type StrideNote,
} from '@stride/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CHAT_HISTORY_LOAD_ERROR, ChatService, recordExternalActivity, redactExternalFailure, shouldDropHeldExecutable } from './chat.service'
import { blankChatSession, ChatTurnError, playChatTurn } from './chat-turn'
import { setAgentProcessHostForTests } from '../platform/agent-process'
import { resetAppDataStore, setAppDataStore } from '../platform/app-data'
import { SettingsService } from '../settings/settings.service'
import { FolderService } from '../vault/folder.service'
import { liveDocStash } from '../vault/live-doc'
import { VaultService } from '../vault/vault.service'
import { parseTurnUndoPack, turnPackListPrefix, turnPackPath } from './chat-turn-diff'
import { createPeerHost } from './external-agent-harness'

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
    agent: { maxTurns: 200, memoryEnabled: false, memoryModelId: '', executables: { grok: null, claude: null, codex: null } },
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
  chat.dropExternalAgent()
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
  chat.externalExec = null
  chat.undoableTurnIds = []
  chat.undoSkippedTurnIds = []
  chat.resetMemoryWork()
  Object.assign(chat, { vaultKeyLoaded: null, controller: null, writeChain: Promise.resolve(), loadTicket: 0 })
  setAgentProcessHostForTests(null)
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
    const vault = resolve(VaultService)
    vault.activeVaultId = ''
    vault.agentMode = 'safe'
    vault.fs = null
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

  it('openFromHistory keeps a legal slot and marks an illegal one without rejecting the file', async () => {
    const { chat } = setup()
    await chat.ensureLoaded()
    const key = vaultStorageKey('vault-1')
    const file = {
      format: 1 as const,
      id: 'ses_ext',
      messages: [{ id: 'm1', role: 'user' as const, text: 'hi', thinking: '', ts: '2026-11-06T08:00:00.000Z', tools: [] }],
      transcript: [],
      memory: { distilledUpTo: 0, lastDistillAt: '' },
      external: {
        grok: { handle: 'old/id+=', cwd: '/vault' },
        claude: { handle: 'bad id', cwd: '/vault' },
        codex: { handle: 'thread/1+=', cwd: 'C:\\vault' },
      },
    }
    await store.writeText(`chats/${key}/ses_ext.json`, serializeSession(file))
    await chat.openFromHistory('ses_ext')
    expect(chat.error).toBe('')
    expect(chat.session.id).toBe('ses_ext')
    expect(chat.session.messages[0]?.text).toBe('hi')
    expect(chat.session.external).toEqual({
      grok: { handle: 'old/id+=', cwd: '/vault' },
      codex: { handle: 'thread/1+=', cwd: 'C:\\vault' },
    })
    expect(chat.session.externalDropped).toEqual(['claude'])
  })

  it('persists external slots and does not write externalDropped', async () => {
    const { chat } = setup()
    chat.session.external = {
      claude: { handle: 'sess_a', cwd: '/vault' },
      grok: { handle: 'g/+=', cwd: '/vault' },
    }
    chat.session.externalDropped = ['codex']
    mockedTurn.mockResolvedValue(turnResult([userMessage('go'), assistantMessage('answer')]))
    chat.draft = 'go'
    await chat.send()
    const key = vaultStorageKey('vault-1')
    const raw = (await store.readText(`chats/${key}/${chat.session.id}.json`))!
    expect(raw).not.toContain('externalDropped')
    expect(parseSession(raw)?.external).toEqual({
      grok: { handle: 'g/+=', cwd: '/vault' },
      claude: { handle: 'sess_a', cwd: '/vault' },
    })
    expect(chat.session.externalDropped).toEqual(['codex'])
  })

  it('redacts activity, pairs a start with its end, and caps the 41st event', () => {
    const { chat } = setup()
    chat.session.messages.push({ role: 'assistant', text: '', thinking: '', tools: [] })
    const budget = { count: 0 }
    const secrets = ['sk-abc', 'sk-abc-xyz']
    const sessionId = chat.session.id
    recordExternalActivity([chat.session], sessionId, {
      id: 't1',
      name: 'read',
      phase: 'start',
      args: { path: 'sk-abc-xyz/note', nested: ['sk-abc'] },
      result: '',
      isError: false,
    }, secrets, budget)
    recordExternalActivity([chat.session], sessionId, {
      id: 't1',
      name: 'read',
      phase: 'end',
      args: {},
      result: 'body sk-abc-xyz tail',
      isError: false,
    }, secrets, budget)
    const paired = chat.session.messages[0]!.tools.find((tool) => tool.id === 't1')!
    expect(chat.session.messages[0]!.tools.filter((tool) => tool.id === 't1')).toHaveLength(1)
    expect(paired.argsSummary).toBe('{"path":"••••/note","nested":["••••"]}')
    expect(paired.argsSummary.length).toBeLessThanOrEqual(120)
    expect(paired.resultSummary).toBe('body •••• tail')
    expect(paired.pending).toBe(false)
    expect(paired.argsSummary).not.toContain('sk-')
    expect(paired.resultSummary).not.toContain('••••-xyz')

    recordExternalActivity([chat.session], sessionId, {
      id: 'late',
      name: 'late',
      phase: 'end',
      args: {},
      result: `${'z'.repeat(250)}`,
      isError: true,
    }, secrets, budget)
    const orphan = chat.session.messages[0]!.tools.find((tool) => tool.id === 'late')!
    expect(orphan.argsSummary).toBe('')
    expect(orphan.resultSummary).toHaveLength(200)
    expect(orphan.isError).toBe(true)

    recordExternalActivity([chat.session], sessionId, {
      id: 'long',
      name: 'long',
      phase: 'start',
      args: { blob: 'q'.repeat(200) },
      result: '',
      isError: false,
    }, [], budget)
    expect(chat.session.messages[0]!.tools.find((tool) => tool.id === 'long')!.argsSummary).toHaveLength(120)

    while (budget.count < 40) {
      recordExternalActivity([chat.session], sessionId, {
        id: `extra-${budget.count}`,
        name: 'extra',
        phase: 'start',
        args: {},
        result: '',
        isError: false,
      }, [], budget)
    }
    recordExternalActivity([chat.session], sessionId, {
      id: 'overflow-1',
      name: 'overflow',
      phase: 'end',
      args: {},
      result: 'hidden',
      isError: false,
    }, [], budget)
    recordExternalActivity([chat.session], sessionId, {
      id: 'overflow-2',
      name: 'overflow',
      phase: 'start',
      args: {},
      result: '',
      isError: false,
    }, [], budget)
    const truncated = chat.session.messages[0]!.tools.filter((tool) => tool.id === 'truncated')
    expect(truncated).toHaveLength(1)
    expect(truncated[0]).toMatchObject({ name: 'truncated', resultSummary: '2 more events omitted' })
    expect(chat.session.messages[0]!.tools.some((tool) => tool.id === 'overflow-1')).toBe(false)
  })

  it('redacts a failed CLI detail longest-first and caps it at 500 characters', () => {
    const secret = 'sk-abc-xyz'
    const detail = `${'a'.repeat(480)}${secret} and sk-abc ${'b'.repeat(80)}`
    const out = redactExternalFailure(detail, ['sk-abc', secret])
    expect(out).not.toContain('sk-')
    expect(out).not.toContain('-xyz')
    expect(out.startsWith('a'.repeat(480))).toBe(true)
    expect(out).toHaveLength(500)
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
    const vault = resolve(VaultService)
    vault.activeVaultId = ''
    vault.agentMode = 'safe'
    vault.fs = null
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

  it('still requires a provider for Safe and Power', async () => {
    const { chat, settings } = setup()
    settings.form = { ...settings.form, llmConfigs: [] }
    chat.draft = 'hello'
    await chat.send()
    expect(chat.error).toBe('Add a model provider, base URL, model, and key in Settings')
    expect(mockedTurn).not.toHaveBeenCalled()
    expect(chat.session.messages).toEqual([])
  })

  it('sends Grok without a provider and restores model switching on Safe', async () => {
    const host = createPeerHost()
    setAgentProcessHostForTests(host)
    const { chat, vault, settings } = setup()
    vault.fs = new MemoryFileSystem('/vault')
    vault.agentMode = 'grok'
    settings.form = { ...settings.form, llmConfigs: [] }
    chat.setModel('cfg1')
    expect(chat.modelId).toBe('')
    chat.draft = 'hello'
    await chat.send()

    expect(chat.error).toBe('')
    expect(chat.session.messages.map((message) => message.text)).toEqual(['hello', 'alpha'])
    expect(chat.session.modelId).toBe('')
    expect(mockedTurn).not.toHaveBeenCalled()
    expect(host.spawns[0]?.args ?? []).not.toContain('--model')

    vault.agentMode = 'safe'
    settings.form = {
      ...settings.form,
      llmConfigs: [
        { id: 'cfg1', name: 'Primary', provider: 'openai', model: 'gpt-4o-mini', baseUrl: 'https://example.test/v1', keyMask: '••••1234', isDefault: true },
        { id: 'cfg2', name: 'Backup', provider: 'openai', model: 'gpt-4o', baseUrl: 'https://example.test/v1', keyMask: '••••5678', isDefault: false },
      ],
    }
    Object.assign(settings, { memoryLlmKeys: { cfg1: 'sk-one', cfg2: 'sk-two' } })
    chat.setModel('cfg2')
    expect(chat.modelId).toBe('cfg2')
    mockedTurn.mockResolvedValue(turnResult([userMessage('back'), assistantMessage('builtin')]))
    chat.draft = 'back'
    await chat.send()
    expect(mockedTurn).toHaveBeenCalledTimes(1)
    expect(chat.session.modelId).toBe('cfg2')
    await host.killAll()
  })
})

describe('held executable command', () => {
  beforeEach(() => {
    store = new MemoryAppDataStore()
    setAppDataStore({ store, persistent: true })
  })

  afterEach(() => {
    resetAppDataStore()
    if (has(ChatService)) resetChat(resolve(ChatService))
    if (has(VaultService)) {
      const vault = resolve(VaultService)
      vault.activeVaultId = ''
      vault.agentMode = 'safe'
      vault.fs = null
    }
  })

  it('does not drop when the saved command matches, including another mode’s path', () => {
    expect(shouldDropHeldExecutable(
      { mode: 'claude', spawnedCommand: '/opt/claude' },
      { grok: '/new/grok', claude: '/opt/claude', codex: null },
    )).toBe(false)
    expect(shouldDropHeldExecutable(
      { mode: 'claude', spawnedCommand: 'claude' },
      { claude: '' },
    )).toBe(false)
    expect(shouldDropHeldExecutable(
      { mode: 'claude', spawnedCommand: 'claude' },
      { claude: '/opt/claude' },
    )).toBe(true)
    expect(shouldDropHeldExecutable(null, { claude: '/opt/claude' })).toBe(false)
  })

  it('saving an unrelated field does not require a process drop', () => {
    const { chat, settings } = setup()
    const drop = vi.spyOn(chat, 'dropExternalAgent')
    chat.externalExec = { mode: 'claude', found: true, resolved: '/opt/claude', command: '/opt/claude' }
    settings.form = {
      ...settings.form,
      agent: {
        ...settings.form.agent,
        maxTurns: 12,
        executables: { grok: '/opt/grok', claude: '/opt/claude', codex: null },
      },
    }
    chat.onExecutableSettingsSaved()
    expect(drop).not.toHaveBeenCalled()
    expect(chat.externalExec).toEqual({ mode: 'claude', found: true, resolved: '/opt/claude', command: '/opt/claude' })
    drop.mockRestore()
  })
})

function noteWith(id: string, text: string): StrideNote {
  return {
    ...createNote(id, id),
    doc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] },
  }
}

async function seedNote(fs: MemoryFileSystem, note: StrideNote): Promise<number> {
  await fs.writeText(notePath(note.id), serializeNote(note))
  const stat = await fs.stat(notePath(note.id))
  return stat?.mtimeMs ?? 0
}

describe('turn undo', () => {
  beforeEach(() => {
    store = new MemoryAppDataStore()
    setAppDataStore({ store, persistent: true })
    mockedTurn.mockReset()
  })

  afterEach(() => {
    resetAppDataStore()
    if (has(ChatService)) resetChat(resolve(ChatService))
    if (has(VaultService)) {
      const vault = resolve(VaultService)
      vault.activeVaultId = ''
      vault.agentMode = 'safe'
      vault.fs = null
      vault.notes = []
      vault.noteMtimes = {}
      vault.diskConflicts = []
      vault.pendingId = ''
      liveDocStash(vault).clear()
    }
  })

  it('does not write a pack for a Safe turn', async () => {
    const { chat, vault } = setup()
    const fs = new MemoryFileSystem('/vault')
    const note = noteWith('moss', 'safe')
    vault.fs = fs
    vault.notes = [note]
    vault.noteMtimes = { moss: await seedNote(fs, note) }
    vault.agentMode = 'safe'
    mockedTurn.mockResolvedValue(turnResult([userMessage('go'), assistantMessage('answer')]))
    chat.draft = 'go'
    await chat.send()
    expect(await store.list('agent-turns/')).toEqual([])
    expect(chat.undoableTurnIds).toEqual([])
  })

  it('packs bash note edits, skips structured ids, and restores on undo', async () => {
    const { chat, vault } = setup()
    if (!has(FolderService)) register(FolderService)
    const fs = new MemoryFileSystem('/vault')
    const bash = noteWith('bash', 'sk-one before')
    const structured = noteWith('structured', 'tool before')
    const moved = noteWith('moved', 'move before')
    vault.fs = fs
    vault.agentMode = 'power'
    vault.notes = [bash, structured, moved]
    vault.noteMtimes = {
      bash: await seedNote(fs, bash),
      structured: await seedNote(fs, structured),
      moved: await seedNote(fs, moved),
    }
    await fs.mkdir('box')
    mockedTurn.mockImplementation(async (input) => {
      const setNote = input.tools?.find((tool) => tool.name === 'set_note')
      const move = input.tools?.find((tool) => tool.name === 'move_note')
      if (!setNote?.execute || !move?.execute) throw new Error('power tools missing')
      await setNote.execute('t1', { id: 'structured', title: 'Structured' })
      await move.execute('t2', { id: 'moved', destFolder: 'box' })
      await fs.writeText(notePath('bash'), serializeNote(noteWith('bash', 'sk-one after')))
      await fs.writeText(notePath('fresh'), serializeNote(noteWith('fresh', 'created body')))
      return turnResult([userMessage('go'), assistantMessage('answer')])
    })
    chat.draft = 'go'
    await chat.send()

    const assistant = chat.session.messages.find((message) => message.role === 'assistant')
    expect(assistant?.id).toBeTruthy()
    expect(assistant?.tools.some((tool) => tool.name === 'file' && tool.argsSummary.includes('"bash"') && tool.resultSummary === 'undoable')).toBe(true)
    expect(assistant?.tools.some((tool) => tool.name === 'file' && tool.argsSummary.includes('structured'))).toBe(true)
    const key = vaultStorageKey('vault-1')
    const rawPack = await store.readText(turnPackPath(key, chat.session.id, assistant!.id!))
    expect(rawPack).toContain('sk-one before')
    expect(rawPack).not.toContain('••••')
    const pack = parseTurnUndoPack(rawPack!)
    expect(pack?.files.map((file) => file.id).sort()).toEqual(['bash', 'fresh'])
    expect(chat.undoableTurnIds).toContain(assistant!.id)

    const sessionId = chat.session.id
    chat.newSession()
    expect(chat.undoableTurnIds).toEqual([])
    await chat.openFromHistory(sessionId)
    expect(chat.undoableTurnIds).toContain(assistant!.id)

    await chat.undoTurn(assistant!.id!)
    expect(await fs.readText(notePath('bash'))).toBe(serializeNote(bash))
    expect(await fs.stat(notePath('fresh'))).toBeNull()
    expect(await fs.stat(notePath('box/moved'))).not.toBeNull()
    expect(vault.notes.some((note) => note.id === 'structured' && note.title === 'Structured')).toBe(true)
  })

  it('leaves a created note that changed after the turn and says so', async () => {
    const { chat, vault } = setup()
    const fs = new MemoryFileSystem('/vault')
    vault.fs = fs
    vault.agentMode = 'power'
    vault.notes = []
    mockedTurn.mockImplementation(async () => {
      await fs.writeText(notePath('fresh'), serializeNote(noteWith('fresh', 'created body')))
      return turnResult([userMessage('go'), assistantMessage('answer')])
    })
    chat.draft = 'go'
    await chat.send()
    const assistantId = chat.session.messages.find((message) => message.role === 'assistant')?.id ?? ''
    await fs.writeText(notePath('fresh'), serializeNote(noteWith('fresh', 'user edited')))
    await chat.undoTurn(assistantId)
    expect(await fs.readText(notePath('fresh'))).toContain('user edited')
    expect(chat.undoSkippedTurnIds).toContain(assistantId)
  })

  it('reads a dirty note from disk and does not write over the unsaved editor', async () => {
    const { chat, vault } = setup()
    const fs = new MemoryFileSystem('/vault')
    const disk = noteWith('moss', 'on disk')
    vault.fs = fs
    vault.agentMode = 'power'
    vault.activeId = 'moss'
    vault.notes = [noteWith('moss', 'UNSAVED EDITOR')]
    vault.noteMtimes = { moss: await seedNote(fs, disk) }
    vault.pendingId = 'moss'
    liveDocStash(vault).set('moss', noteWith('moss', 'UNSAVED EDITOR').doc)
    mockedTurn.mockImplementation(async () => {
      await fs.writeText(notePath('moss'), serializeNote(noteWith('moss', 'agent wrote')))
      return turnResult([userMessage('go'), assistantMessage('answer')])
    })
    chat.draft = 'go'
    await chat.send()
    const assistantId = chat.session.messages.find((message) => message.role === 'assistant')?.id ?? ''
    const key = vaultStorageKey('vault-1')
    const rawPack = await store.readText(turnPackPath(key, chat.session.id, assistantId))
    expect(rawPack).toContain('on disk')
    expect(rawPack).not.toContain('UNSAVED EDITOR')
    await chat.undoTurn(assistantId)
    expect(await fs.readText(notePath('moss'))).toContain('agent wrote')
    expect(vault.diskConflicts.map((item) => item.id)).toContain('moss')
  })

  it('still writes the pack when the turn fails', async () => {
    const { chat, vault } = setup()
    const fs = new MemoryFileSystem('/vault')
    const note = noteWith('moss', 'before')
    vault.fs = fs
    vault.agentMode = 'power'
    vault.notes = [note]
    vault.noteMtimes = { moss: await seedNote(fs, note) }
    mockedTurn.mockImplementation(async () => {
      await fs.writeText(notePath('moss'), serializeNote(noteWith('moss', 'after')))
      throw new Error('provider down')
    })
    chat.draft = 'go'
    await chat.send()
    expect(chat.error).toBe('provider down')
    const assistantId = chat.session.messages.find((message) => message.role === 'assistant')?.id ?? ''
    const rawPack = await store.readText(turnPackPath(vaultStorageKey('vault-1'), chat.session.id, assistantId))
    expect(parseTurnUndoPack(rawPack!)?.files.map((file) => file.id)).toEqual(['moss'])
  })

  it('keeps the newest three packs and deletes session packs by file', async () => {
    const { chat, vault } = setup()
    const fs = new MemoryFileSystem('/vault')
    const note = noteWith('n', 'v0')
    vault.fs = fs
    vault.agentMode = 'power'
    vault.notes = [note]
    vault.noteMtimes = { n: await seedNote(fs, note) }
    for (let index = 1; index <= 4; index += 1) {
      const version = index
      mockedTurn.mockImplementation(async () => {
        await fs.writeText(notePath('n'), serializeNote(noteWith('n', `v${version}`)))
        return turnResult([userMessage('go'), assistantMessage('answer')])
      })
      chat.draft = `m${version}`
      await chat.send()
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    const key = vaultStorageKey('vault-1')
    const prefix = turnPackListPrefix(key, chat.session.id)
    expect(await store.list(prefix)).toHaveLength(3)
    const remove = vi.spyOn(store, 'remove')
    const sessionId = chat.session.id
    await chat.deleteSession(sessionId)
    expect(remove.mock.calls.map((call) => call[0])).not.toContain(prefix)
    expect(await store.list(prefix)).toEqual([])
    expect(await store.readText(`chats/${key}/${sessionId}.json`)).toBeNull()
    remove.mockRestore()
  })

  it('does not exclude structured ids on an external turn', async () => {
    const host = createPeerHost()
    setAgentProcessHostForTests(host)
    const { chat, vault } = setup()
    const fs = new MemoryFileSystem('/vault')
    const note = noteWith('kept', 'before')
    vault.fs = fs
    vault.notes = [note]
    vault.noteMtimes = { kept: await seedNote(fs, note) }
    vault.agentMode = 'power'
    mockedTurn.mockImplementation(async (input) => {
      const setNote = input.tools?.find((tool) => tool.name === 'set_note')
      if (!setNote?.execute) throw new Error('set_note missing')
      await setNote.execute('t1', { id: 'kept', title: 'Tool' })
      return turnResult([userMessage('first'), assistantMessage('answer')])
    })
    try {
      chat.draft = 'first'
      await chat.send()
      vault.agentMode = 'grok'
      const spawn = host.spawn.bind(host)
      host.spawn = async (spec) => {
        await fs.writeText(notePath('kept'), serializeNote(noteWith('kept', 'cli wrote')))
        return spawn(spec)
      }
      chat.draft = 'second'
      await chat.send()
      const assistantId = [...chat.session.messages].reverse().find((message) => message.role === 'assistant')?.id ?? ''
      const rawPack = await store.readText(turnPackPath(vaultStorageKey('vault-1'), chat.session.id, assistantId))
      expect(parseTurnUndoPack(rawPack!)?.files.map((file) => file.id)).toContain('kept')
      expect(rawPack).toContain('Tool')
    } finally {
      await host.killAll()
    }
  })
})
