import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { MemoryAppDataStore } from '@stride/platform'
import {
  CURATE_MEMORY_PROMPT,
  DISTILL_MEMORY_PROMPT,
  emptyMemoryIndex,
  parseMemoryIndex,
  parseSession,
  serializeMemoryIndex,
  serializeSession,
  vaultStorageKey,
  type AgentUsage,
  type ChatSessionFile,
  type MemoryToolHost,
} from '@stride/core'
import { CHAT_MEMORY_WORK_ERROR, ChatMemoryDistiller, type ChatMemoryDistillerDeps } from './chat-memory-distill'
import { chatMemoryHostKeyed } from './chat-memory-host'
import { ChatTurnError, playChatTurn } from './chat-turn'
import { resetAppDataStore, setAppDataStore } from '../platform/app-data'

vi.mock('./chat-turn', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./chat-turn')>()
  return { ...actual, playChatTurn: vi.fn() }
})

const mockedTurn = vi.mocked(playChatTurn)

const VAULT_KEY = vaultStorageKey('vault-1')

let store: MemoryAppDataStore

function usage(): AgentUsage {
  return { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, costTotal: 0 }
}

function userMessage(text: string): AgentMessage {
  return { role: 'user', content: text, timestamp: 1 } as AgentMessage
}

function assistantMessage(text: string, stopReason = 'stop'): AgentMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    stopReason,
    timestamp: 2,
  } as unknown as AgentMessage
}

function turnResult(transcript: AgentMessage[], overrides: Partial<Awaited<ReturnType<typeof playChatTurn>>> = {}) {
  return {
    text: '',
    usage: usage(),
    aborted: false,
    turnLimit: false,
    transcript,
    ...overrides,
  }
}

function sessionFile(id: string, transcript: AgentMessage[], distilledUpTo = 0): ChatSessionFile {
  return {
    format: 1,
    id,
    messages: [],
    transcript,
    memory: { distilledUpTo, lastDistillAt: '' },
  }
}

async function seedSession(id: string, transcript: AgentMessage[], distilledUpTo = 0) {
  await store.writeText(`chats/${VAULT_KEY}/${id}.json`, serializeSession(sessionFile(id, transcript, distilledUpTo)))
}

function setup(overrides: Partial<ChatMemoryDistillerDeps> = {}) {
  const hosts = new Map<string, MemoryToolHost>()
  const deps: ChatMemoryDistillerDeps = {
    runtime: () => ({ provider: 'openai', model: 'gpt-4o-mini', baseUrl: 'https://example.test/v1', apiKey: 'sk-test' }),
    baseUrl: (url) => url,
    host: (key) => {
      let host = hosts.get(key)
      if (!host) {
        host = chatMemoryHostKeyed(key)
        hosts.set(key, host)
      }
      return host
    },
    sessionRunning: () => false,
    cursorAdvanced: vi.fn(),
    setBusy: vi.fn(),
    setError: vi.fn(),
    ...overrides,
  }
  return { deps, distiller: new ChatMemoryDistiller(deps) }
}

describe('ChatMemoryDistiller', () => {
  beforeEach(() => {
    store = new MemoryAppDataStore()
    setAppDataStore({ store, persistent: true })
    mockedTurn.mockReset()
    mockedTurn.mockImplementation(async (input) => turnResult([userMessage('x')], { text: input.prompt.slice(0, 10) }))
  })

  afterEach(() => {
    resetAppDataStore()
  })

  it('distills only the increment and advances cursor and distillCount', async () => {
    const { deps, distiller } = setup()
    const transcript = [userMessage('a'), assistantMessage('b'), userMessage('c'), assistantMessage('d')]
    await seedSession('ses_1', transcript, 2)

    distiller.request(VAULT_KEY, 'ses_1')
    await distiller.whenSettled()

    expect(mockedTurn).toHaveBeenCalledTimes(1)
    const args = mockedTurn.mock.calls[0]?.[0]
    expect(args?.systemPrompt).toContain(DISTILL_MEMORY_PROMPT)
    expect(args?.prompt).toBe(JSON.stringify(transcript.slice(2)))
    expect((args?.tools ?? []).map((tool) => tool.name)).toEqual(['memory_read', 'memory_write', 'memory_forget'])

    const file = parseSession((await store.readText(`chats/${VAULT_KEY}/ses_1.json`))!)!
    expect(file.memory.distilledUpTo).toBe(4)
    expect(file.memory.lastDistillAt).not.toBe('')
    expect(deps.cursorAdvanced).toHaveBeenCalledWith('ses_1', expect.objectContaining({ distilledUpTo: 4 }))
    const index = parseMemoryIndex((await store.readText(`memory/${VAULT_KEY}/index.json`))!)!
    expect(index.distillCount).toBe(1)
    expect(deps.setError).not.toHaveBeenCalledWith(CHAT_MEMORY_WORK_ERROR)
  })

  it('advances the cursor without a model call when the increment is only an aborted tail', async () => {
    const { deps, distiller } = setup()
    const transcript = [userMessage('a'), assistantMessage('half', 'aborted')]
    await seedSession('ses_1', transcript, 1)

    distiller.request(VAULT_KEY, 'ses_1')
    await distiller.whenSettled()

    expect(mockedTurn).not.toHaveBeenCalled()
    const file = parseSession((await store.readText(`chats/${VAULT_KEY}/ses_1.json`))!)!
    expect(file.memory.distilledUpTo).toBe(2)
    expect(deps.cursorAdvanced).toHaveBeenCalled()
    // A bookkeeping skip is not a distillation: the counter stays untouched.
    expect(await store.readText(`memory/${VAULT_KEY}/index.json`)).toBeNull()
  })

  it('skips silently when no memory model is configured', async () => {
    const { deps, distiller } = setup({ runtime: () => null })
    await seedSession('ses_1', [userMessage('a'), assistantMessage('b')])

    distiller.request(VAULT_KEY, 'ses_1')
    await distiller.whenSettled()

    expect(mockedTurn).not.toHaveBeenCalled()
    expect(deps.setError).not.toHaveBeenCalled()
    const file = parseSession((await store.readText(`chats/${VAULT_KEY}/ses_1.json`))!)!
    expect(file.memory.distilledUpTo).toBe(0)
  })

  it('defers a session that is mid-turn', async () => {
    const { deps, distiller } = setup({ sessionRunning: () => true })
    await seedSession('ses_1', [userMessage('a'), assistantMessage('b')])

    distiller.request(VAULT_KEY, 'ses_1')
    await distiller.whenSettled()

    expect(mockedTurn).not.toHaveBeenCalled()
    expect(deps.cursorAdvanced).not.toHaveBeenCalled()
  })

  it('reruns a session requested again while its pass is in flight (dirty)', async () => {
    const { distiller } = setup()
    const transcript = [userMessage('a'), assistantMessage('b')]
    await seedSession('ses_1', transcript)

    let release!: () => void
    const gate = new Promise<void>((resolvePromise) => {
      release = () => resolvePromise()
    })
    mockedTurn.mockImplementationOnce(() => gate.then(() => turnResult(transcript)))

    distiller.request(VAULT_KEY, 'ses_1')
    // Wait until the first pass is definitely in flight, then trigger again.
    await vi.waitFor(() => expect(mockedTurn).toHaveBeenCalledTimes(1))
    distiller.request(VAULT_KEY, 'ses_1')
    release()
    await distiller.whenSettled()

    // The rerun re-reads the file: the cursor was already advanced, so the
    // second pass finds no increment and makes no further model call.
    expect(mockedTurn).toHaveBeenCalledTimes(1)
    const file = parseSession((await store.readText(`chats/${VAULT_KEY}/ses_1.json`))!)!
    expect(file.memory.distilledUpTo).toBe(2)
  })

  it('serializes sessions of one vault key through a single runner', async () => {
    const { distiller } = setup()
    await seedSession('ses_a', [userMessage('a'), assistantMessage('b')])
    await seedSession('ses_b', [userMessage('c'), assistantMessage('d')])

    const order: string[] = []
    mockedTurn.mockImplementation(async (input) => {
      order.push(input.prompt)
      return turnResult([])
    })

    distiller.request(VAULT_KEY, 'ses_a')
    distiller.request(VAULT_KEY, 'ses_b')
    await distiller.whenSettled()

    expect(mockedTurn).toHaveBeenCalledTimes(2)
    expect(order).toEqual([
      JSON.stringify([userMessage('a'), assistantMessage('b')]),
      JSON.stringify([userMessage('c'), assistantMessage('d')]),
    ])
  })

  it('runs curation after every tenth distillation', async () => {
    const { distiller } = setup()
    await seedSession('ses_1', [userMessage('a'), assistantMessage('b')])
    await store.writeText(
      `memory/${VAULT_KEY}/index.json`,
      serializeMemoryIndex({ ...emptyMemoryIndex('2026-11-06T09:00:00.000Z'), distillCount: 9 }),
    )

    distiller.request(VAULT_KEY, 'ses_1')
    await distiller.whenSettled()

    expect(mockedTurn).toHaveBeenCalledTimes(2)
    expect(mockedTurn.mock.calls[0]?.[0].systemPrompt).toContain(DISTILL_MEMORY_PROMPT)
    expect(mockedTurn.mock.calls[1]?.[0].systemPrompt).toBe(CURATE_MEMORY_PROMPT)
    const index = parseMemoryIndex((await store.readText(`memory/${VAULT_KEY}/index.json`))!)!
    expect(index.distillCount).toBe(10)
  })

  it('reports failures once and leaves the cursor for a retry', async () => {
    const { deps, distiller } = setup()
    await seedSession('ses_1', [userMessage('a'), assistantMessage('b')])
    mockedTurn.mockRejectedValue(new ChatTurnError('provider down', []))

    distiller.request(VAULT_KEY, 'ses_1')
    await distiller.whenSettled()

    expect(deps.setError).toHaveBeenCalledWith(CHAT_MEMORY_WORK_ERROR)
    const file = parseSession((await store.readText(`chats/${VAULT_KEY}/ses_1.json`))!)!
    expect(file.memory.distilledUpTo).toBe(0)
  })

  it('does not advance the cursor when the pass is aborted', async () => {
    const { deps, distiller } = setup()
    await seedSession('ses_1', [userMessage('a'), assistantMessage('b')])
    mockedTurn.mockImplementation(async () => turnResult([], { aborted: true }))

    distiller.request(VAULT_KEY, 'ses_1')
    await distiller.whenSettled()

    expect(deps.cursorAdvanced).not.toHaveBeenCalled()
    expect(deps.setError).not.toHaveBeenCalled()
    const file = parseSession((await store.readText(`chats/${VAULT_KEY}/ses_1.json`))!)!
    expect(file.memory.distilledUpTo).toBe(0)
  })

  it('keeps queued sessions after a cancel for the next trigger', async () => {
    const { distiller } = setup()
    const transcriptA = [userMessage('a'), assistantMessage('b')]
    const transcriptB = [userMessage('c'), assistantMessage('d')]
    await seedSession('ses_a', transcriptA)
    await seedSession('ses_b', transcriptB)

    let release!: () => void
    const gate = new Promise<void>((resolvePromise) => {
      release = () => resolvePromise()
    })
    mockedTurn.mockImplementationOnce((input) =>
      gate.then(() => turnResult(transcriptA, { aborted: input.signal?.aborted === true })),
    )

    distiller.request(VAULT_KEY, 'ses_a')
    distiller.request(VAULT_KEY, 'ses_b')
    await vi.waitFor(() => expect(mockedTurn).toHaveBeenCalledTimes(1))
    distiller.cancel()
    release()
    await distiller.whenSettled()

    // The cancelled run stopped after the aborted pass; ses_b stayed queued.
    expect(mockedTurn).toHaveBeenCalledTimes(1)
    const fileA = parseSession((await store.readText(`chats/${VAULT_KEY}/ses_a.json`))!)!
    const fileB = parseSession((await store.readText(`chats/${VAULT_KEY}/ses_b.json`))!)!
    expect(fileA.memory.distilledUpTo).toBe(0)
    expect(fileB.memory.distilledUpTo).toBe(0)

    // The next trigger drains the preserved queue (and re-enqueues ses_a).
    distiller.request(VAULT_KEY, 'ses_a')
    distiller.request(VAULT_KEY, 'ses_b')
    await distiller.whenSettled()
    expect(mockedTurn).toHaveBeenCalledTimes(3)
    const afterA = parseSession((await store.readText(`chats/${VAULT_KEY}/ses_a.json`))!)!
    const afterB = parseSession((await store.readText(`chats/${VAULT_KEY}/ses_b.json`))!)!
    expect(afterA.memory.distilledUpTo).toBe(2)
    expect(afterB.memory.distilledUpTo).toBe(2)
  })

  it('startup scan enqueues only sessions with an undistilled increment, once per vault', async () => {
    const { distiller } = setup()
    await seedSession('ses_dirty', [userMessage('a'), assistantMessage('b')], 0)
    await seedSession('ses_clean', [userMessage('c'), assistantMessage('d')], 2)

    distiller.scan(VAULT_KEY, ['ses_dirty', 'ses_clean'])
    await distiller.whenSettled()
    await vi.waitFor(() => expect(mockedTurn).toHaveBeenCalledTimes(1))
    await distiller.whenSettled()
    expect(mockedTurn.mock.calls[0]?.[0].prompt).toBe(JSON.stringify([userMessage('a'), assistantMessage('b')]))

    // A repeated scan for the same vault is a no-op.
    distiller.scan(VAULT_KEY, ['ses_dirty', 'ses_clean'])
    await distiller.whenSettled()
    expect(mockedTurn).toHaveBeenCalledTimes(1)
  })

  it('startup scan waits for a configured memory model', async () => {
    const { distiller } = setup({ runtime: () => null })
    distiller.scan(VAULT_KEY, ['ses_dirty'])
    await distiller.whenSettled()
    expect(mockedTurn).not.toHaveBeenCalled()
  })
})
