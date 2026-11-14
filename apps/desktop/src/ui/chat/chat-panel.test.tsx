import { register, resolve } from '@rabjs/react'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryAppDataStore, MemoryFileSystem } from '@stride/platform'
import {
  markDedicatedVault,
  newSessionId,
  readAgentMode,
  serializeSession,
  serializeSessionMeta,
  vaultStorageKey,
  type ChatSessionFile,
  type ChatSessionMeta,
} from '@stride/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CHAT_TURN_LIMIT_ERROR, ChatService } from '../../services/chat/chat.service'
import { blankChatSession, playChatTurn } from '../../services/chat/chat-turn'
import { setAgentProcessHostForTests } from '../../services/platform/agent-process'
import { createPeerHost } from '../../services/chat/external-agent-harness'
import { resetAppDataStore, setAppDataStore } from '../../services/platform/app-data'
import { SettingsService } from '../../services/settings/settings.service'
import { VaultService } from '../../services/vault/vault.service'
import { ChatPanel } from './chat-panel'

vi.mock('../../services/chat/chat-turn', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/chat/chat-turn')>()
  return { ...actual, playChatTurn: vi.fn() }
})

const mockedTurn = vi.mocked(playChatTurn)

function host(): { host: HTMLDivElement; root: Root } {
  const element = document.createElement('div')
  document.body.appendChild(element)
  return { host: element, root: createRoot(element) }
}

// jsdom lacks the pointer/scroll APIs Radix Select touches when it opens.
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {}
}
for (const method of ['hasPointerCapture', 'setPointerCapture', 'releasePointerCapture'] as const) {
  if (!(method in Element.prototype)) {
    ;(Element.prototype as unknown as Record<string, unknown>)[method] = () => false
  }
}

async function render(root: Root, node: ReactNode) {
  await act(async () => {
    root.render(node)
  })
}

async function unmount(element: HTMLDivElement, root: Root) {
  await act(async () => {
    root.unmount()
  })
  element.remove()
}

function resetChat() {
  const chat = resolve(ChatService)
  chat.dropExternalAgent()
  setAgentProcessHostForTests(null)
  chat.modelId = ''
  chat.draft = ''
  chat.error = ''
  chat.running = false
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
  Object.assign(chat, { vaultKeyLoaded: null })
  const settings = resolve(SettingsService)
  settings.form = { ...settings.form, llmConfigs: [] }
  const vault = resolve(VaultService)
  vault.agentMode = 'safe'
  vault.activeVaultId = ''
  vault.fs = null
  resetAppDataStore()
}

async function openMode(trigger: Element) {
  await act(async () => {
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
}

function modeItem(testId: string): Element | null {
  return document.querySelector(`[data-testid="${testId}"]`)
}

function storedMeta(overrides: Partial<ChatSessionMeta> = {}): ChatSessionMeta {
  return {
    format: 1,
    id: 'ses_1',
    vaultKey: vaultStorageKey('vault-1'),
    vaultLabel: 'vault',
    title: 'Stored title',
    createdAt: '2026-11-06T08:00:00.000Z',
    updatedAt: '2026-11-06T08:12:31.000Z',
    status: 'closed',
    modelId: 'a',
    messageCount: 1,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, costTotal: 0 },
    ...overrides,
  }
}

function storedFile(meta: ChatSessionMeta): ChatSessionFile {
  return {
    format: 1,
    id: meta.id,
    messages: [{ id: 'm1', role: 'user', text: 'hi', thinking: '', ts: meta.createdAt, tools: [] }],
    transcript: [],
    memory: { distilledUpTo: 0, lastDistillAt: '' },
  }
}

describe('ChatPanel', () => {
  afterEach(() => {
    resetChat()
  })

  it('shows the single-row header with history, title, close, and new — no tabs', async () => {
    register(VaultService)
    register(SettingsService)
    register(ChatService)
    const { host: element, root } = host()
    try {
      await render(root, <ChatPanel />)
      expect(element.querySelector('.panel-heading')).toBeNull()
      expect(element.querySelector('[data-testid="chat-tabs"]')).toBeNull()
      const header = element.querySelector('.chat-header')
      expect(header?.querySelector('[data-testid="chat-history"]')).not.toBeNull()
      expect(header?.querySelector('[data-testid="chat-title"]')).not.toBeNull()
      expect(header?.querySelector('[data-testid="chat-new"]')).not.toBeNull()
      expect(header?.querySelector('[data-testid="chat-close"]')).not.toBeNull()
      // Stop only shows while a turn is running.
      expect(header?.querySelector('[data-testid="chat-stop"]')).toBeNull()
      expect(element.querySelector('[data-testid="chat-model-empty"]')?.textContent).toBe('Add a model in Settings')
      const modeTrigger = element.querySelector('[data-testid="chat-mode"]')!
      expect(modeTrigger.textContent).toContain('Safe')
      expect(element.querySelector('.chat-compose')).not.toBeNull()

      await act(async () => {
        modeTrigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      })
      const power = document.querySelector('[data-testid="chat-mode-power"]')
      expect(power).not.toBeNull()
      expect(document.querySelector('[data-testid="chat-mode-safe"]')).not.toBeNull()
      for (const [testId, label] of [
        ['chat-mode-grok', 'Grok'],
        ['chat-mode-claude', 'Claude Code'],
        ['chat-mode-codex', 'Codex'],
      ] as const) {
        const item = modeItem(testId)
        expect(item?.textContent).toContain(label)
        expect(item?.hasAttribute('data-disabled')).toBe(true)
      }
      await act(async () => {
        power!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      expect(resolve(VaultService).agentMode).toBe('power')

      await act(async () => {
        resolve(ChatService).running = true
      })
      expect(header?.querySelector('[data-testid="chat-stop"]')).not.toBeNull()
      await act(async () => {
        resolve(ChatService).running = false
      })
    } finally {
      await unmount(element, root)
    }
  })

  it('selects a saved model for the next turn', async () => {
    register(VaultService)
    register(SettingsService)
    register(ChatService)
    const settings = resolve(SettingsService)
    settings.form = {
      ...settings.form,
      llmConfigs: [
        { id: 'a', name: 'Primary', provider: 'openai', model: 'gpt-4o-mini', baseUrl: '', keyMask: '', isDefault: true },
        { id: 'b', name: 'Backup', provider: 'deepseek', model: 'deepseek-chat', baseUrl: '', keyMask: '', isDefault: false },
      ],
    }
    const { host: element, root } = host()
    try {
      await render(root, <ChatPanel />)
      const trigger = element.querySelector('[data-testid="chat-model"]')
      expect(trigger?.textContent).toContain('Primary · gpt-4o-mini')
      expect(resolve(ChatService).activeModelId).toBe('a')

      await act(async () => {
        resolve(ChatService).setModel('b')
      })
      expect(element.querySelector('[data-testid="chat-model"]')?.textContent).toContain('Backup · deepseek-chat')
      expect(resolve(ChatService).activeModelId).toBe('b')

      await act(async () => {
        resolve(ChatService).setModel('missing')
      })
      expect(resolve(ChatService).modelId).toBe('b')
    } finally {
      await unmount(element, root)
    }
  })

  it('collapses an assistant message\'s tool calls into a summary row', async () => {
    register(VaultService)
    register(SettingsService)
    register(ChatService)
    const chat = resolve(ChatService)
    const session = blankChatSession('session-1')
    session.messages.push({
      role: 'assistant',
      text: 'done',
      thinking: '',
      tools: [
        {
          id: 'call-1',
          name: 'read_note',
          argsSummary: '{"id":"规则"}',
          resultSummary: '{"content":"Note not found"}',
          durationMs: 2,
          isError: false,
          pending: false,
        },
        {
          id: 'call-2',
          name: 'search_vault',
          argsSummary: '{"query":"moss"}',
          resultSummary: 'one hit',
          durationMs: 12,
          isError: false,
          pending: false,
        },
      ],
    })
    chat.session = session
    const { host: element, root } = host()
    try {
      await render(root, <ChatPanel />)
      const summary = element.querySelector('[data-testid="chat-tools-summary"]') as HTMLButtonElement | null
      expect(summary).not.toBeNull()
      expect(summary?.textContent).toContain('2 tool calls')
      // Tool rows stay hidden until the summary expands.
      expect(element.querySelector('details[data-testid="chat-tool"]')).toBeNull()

      await act(async () => {
        summary!.click()
      })
      const tools = element.querySelectorAll('details[data-testid="chat-tool"]')
      expect(tools).toHaveLength(2)
      const first = tools[0] as HTMLDetailsElement
      expect(first.open).toBe(false)
      expect(first.querySelector('[data-testid="chat-tool-name"]')?.textContent).toBe('read_note')
      expect(first.querySelector('[data-testid="chat-tool-duration"]')?.textContent).toBe('2 ms')
      expect(first.querySelector('[data-testid="chat-tool-args"]')?.textContent).toContain('规则')
    } finally {
      await unmount(element, root)
    }
  })

  it('marks the failed count on the summary row', async () => {
    register(VaultService)
    register(SettingsService)
    register(ChatService)
    const chat = resolve(ChatService)
    const session = blankChatSession('session-1')
    session.messages.push({
      role: 'assistant',
      text: '',
      thinking: '',
      tools: [
        { id: 'call-1', name: 'read_note', argsSummary: '', resultSummary: 'boom', durationMs: 3, isError: true, pending: false },
        { id: 'call-2', name: 'list_notes', argsSummary: '', resultSummary: 'ok', durationMs: 5, isError: false, pending: false },
      ],
    })
    chat.session = session
    const { host: element, root } = host()
    try {
      await render(root, <ChatPanel />)
      expect(element.querySelector('[data-testid="chat-tools-failed"]')?.textContent).toContain('1 failed')
      expect(element.querySelector('.chat-tools')?.classList.contains('is-error')).toBe(true)
    } finally {
      await unmount(element, root)
    }
  })

  it('opens the history overlay, recalls a session, and deletes it', async () => {
    register(VaultService)
    register(SettingsService)
    register(ChatService)
    const store = new MemoryAppDataStore()
    setAppDataStore({ store, persistent: true })
    const chat = resolve(ChatService)
    const vault = resolve(VaultService)
    vault.activeVaultId = 'vault-1'
    const meta = storedMeta()
    await store.writeText(`chats/${vaultStorageKey('vault-1')}/ses_1.meta.json`, serializeSessionMeta(meta))
    await store.writeText(`chats/${vaultStorageKey('vault-1')}/ses_1.json`, serializeSession(storedFile(meta)))
    const { host: element, root } = host()
    try {
      await render(root, <ChatPanel />)
      await act(async () => {
        await chat.ensureLoaded()
      })
      const historyButton = element.querySelector('[data-testid="chat-history"]') as HTMLButtonElement
      await act(async () => {
        historyButton.click()
      })
      const list = element.querySelector('[data-testid="chat-history-list"]')
      expect(list).not.toBeNull()
      const item = list?.querySelector('[data-testid="chat-history-item"]')
      expect(item?.textContent).toContain('Stored title')
      expect(item?.textContent).toContain('1 messages')

      await act(async () => {
        ;(item!.querySelector('[data-testid="chat-history-open"]') as HTMLButtonElement).click()
      })
      expect(chat.historyOpen).toBe(false)
      expect(chat.session.id).toBe('ses_1')
      expect(element.querySelector('[data-testid="chat-title"]')?.textContent).toBe('Stored title')

      await act(async () => {
        historyButton.click()
      })
      const deleteButton = element.querySelector('[data-testid="chat-history-delete"]') as HTMLButtonElement
      await act(async () => {
        deleteButton.click()
      })
      expect(chat.metas).toEqual([])
      expect(await store.readText(`chats/${vaultStorageKey('vault-1')}/ses_1.json`)).toBeNull()
      // Deleting the staged session returned the panel to a blank one.
      expect(chat.session.id).not.toBe('ses_1')
      expect(chat.session.messages).toEqual([])
    } finally {
      await unmount(element, root)
    }
  })

  it('shows an empty state when there is no history', async () => {
    register(VaultService)
    register(SettingsService)
    register(ChatService)
    setAppDataStore({ store: new MemoryAppDataStore(), persistent: true })
    resolve(VaultService).activeVaultId = 'vault-1'
    const chat = resolve(ChatService)
    const { host: element, root } = host()
    try {
      await render(root, <ChatPanel />)
      await act(async () => {
        await chat.ensureLoaded()
        chat.showHistory()
      })
      expect(element.querySelector('[data-testid="chat-history-list"]')).not.toBeNull()
      expect(element.querySelector('[data-testid="chat-history-empty"]')).not.toBeNull()
      await act(async () => {
        chat.closeHistory()
      })
    } finally {
      await unmount(element, root)
    }
  })

  it('warns when the environment cannot persist sessions', async () => {
    register(VaultService)
    register(SettingsService)
    register(ChatService)
    setAppDataStore({ store: new MemoryAppDataStore(), persistent: false })
    const chat = resolve(ChatService)
    const { host: element, root } = host()
    try {
      await render(root, <ChatPanel />)
      await act(async () => {
        await chat.ensureLoaded()
      })
      expect(element.querySelector('[data-testid="chat-degraded"]')?.textContent).toBe(
        'Sessions and memory are not saved in this environment.',
      )
    } finally {
      await unmount(element, root)
    }
  })

  it('reports the configured turn limit', async () => {
    register(VaultService)
    register(SettingsService)
    register(ChatService)
    const chat = resolve(ChatService)
    chat.error = CHAT_TURN_LIMIT_ERROR
    const { host: element, root } = host()
    try {
      await render(root, <ChatPanel />)
      expect(element.querySelector('[data-testid="chat-error"]')?.textContent).toBe('Reached the 200-turn limit and stopped.')
      await act(async () => {
        const settings = resolve(SettingsService)
        settings.form = { ...settings.form, agent: { ...settings.form.agent, maxTurns: 40 } }
      })
      expect(element.querySelector('[data-testid="chat-error"]')?.textContent).toBe('Reached the 40-turn limit and stopped.')
    } finally {
      await unmount(element, root)
    }
  })

  it('shows a cancelable status line while memory work runs, and a one-shot failure line', async () => {
    register(VaultService)
    register(SettingsService)
    register(ChatService)
    const chat = resolve(ChatService)
    const { host: element, root } = host()
    try {
      await render(root, <ChatPanel />)
      expect(element.querySelector('[data-testid="chat-memory-busy"]')).toBeNull()
      expect(element.querySelector('[data-testid="chat-memory-error"]')).toBeNull()

      await act(async () => {
        chat.memoryBusy = true
      })
      expect(element.querySelector('[data-testid="chat-memory-busy"]')?.textContent).toContain('Organizing memory')
      const cancel = element.querySelector('[data-testid="chat-memory-cancel"]') as HTMLButtonElement
      expect(cancel).not.toBeNull()

      await act(async () => {
        chat.memoryError = 'memory-work-failed'
        chat.memoryBusy = false
      })
      expect(element.querySelector('[data-testid="chat-memory-busy"]')).toBeNull()
      expect(element.querySelector('[data-testid="chat-memory-error"]')?.textContent).toContain('failed')
    } finally {
      await unmount(element, root)
    }
  })

  it('persists Grok, Claude Code, and Codex and locks the model control', async () => {
    register(VaultService)
    register(SettingsService)
    register(ChatService)
    const peer = createPeerHost()
    setAgentProcessHostForTests(peer)
    const vault = resolve(VaultService)
    const fs = new MemoryFileSystem('/field-notes')
    await markDedicatedVault(fs)
    vault.fs = fs
    const settings = resolve(SettingsService)
    settings.form = {
      ...settings.form,
      llmConfigs: [
        { id: 'a', name: 'Primary', provider: 'openai', model: 'gpt-4o-mini', baseUrl: '', keyMask: '', isDefault: true },
        { id: 'b', name: 'Backup', provider: 'deepseek', model: 'deepseek-chat', baseUrl: '', keyMask: '', isDefault: false },
      ],
    }
    const chat = resolve(ChatService)
    const { host: element, root } = host()
    try {
      await render(root, <ChatPanel />)
      const trigger = element.querySelector('[data-testid="chat-mode"]')!
      for (const [mode, testId, label] of [
        ['grok', 'chat-mode-grok', 'Grok'],
        ['claude', 'chat-mode-claude', 'Claude Code'],
        ['codex', 'chat-mode-codex', 'Codex'],
      ] as const) {
        await openMode(trigger)
        const option = modeItem(testId)
        expect(option?.textContent).toContain(label)
        expect(option?.hasAttribute('data-disabled')).toBe(false)
        await act(async () => {
          option!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        })
        await vi.waitUntil(async () => (await readAgentMode(fs)) === mode, { timeout: 2000 })
        expect(vault.agentMode).toBe(mode)
        expect(element.querySelector('[data-testid="chat-model"]')).toBeNull()
        expect(element.querySelector('[data-testid="chat-external-model"]')?.textContent).toContain('default model')
        await act(async () => {
          chat.setModel('b')
        })
        expect(chat.modelId).toBe('')
      }

      await openMode(trigger)
      await act(async () => {
        modeItem('chat-mode-safe')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      await vi.waitUntil(async () => (await readAgentMode(fs)) === 'safe', { timeout: 2000 })
      expect(element.querySelector('[data-testid="chat-model"]')).not.toBeNull()
      await act(async () => {
        chat.setModel('b')
      })
      expect(chat.modelId).toBe('b')
      expect(element.querySelector('[data-testid="chat-model"]')?.textContent).toContain('Backup')

      const draft = element.querySelector('[data-testid="chat-draft"]') as HTMLTextAreaElement
      await openMode(trigger)
      await act(async () => {
        modeItem('chat-mode-grok')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      await vi.waitUntil(() => vault.agentMode === 'grok')
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
        setter?.call(draft, 'hello from the composer')
        draft.dispatchEvent(new Event('input', { bubbles: true }))
      })
      mockedTurn.mockClear()
      await act(async () => {
        ;(element.querySelector('[data-testid="chat-send"]') as HTMLButtonElement).click()
      })
      await vi.waitUntil(() => chat.session.messages.some((message) => message.text === 'alpha'), { timeout: 5000 })
      expect(chat.error).toBe('')
      expect(element.querySelector('[data-testid="chat-error"]')).toBeNull()
      expect(mockedTurn).not.toHaveBeenCalled()
      expect(chat.session.modelId).toBe('')
    } finally {
      chat.dropExternalAgent()
      await peer.killAll()
      await unmount(element, root)
    }
  })

  it('shows a persisted external mode as unavailable in the browser', async () => {
    register(VaultService)
    register(SettingsService)
    register(ChatService)
    resolve(VaultService).agentMode = 'claude'
    const { host: element, root } = host()
    try {
      await render(root, <ChatPanel />)
      expect(element.querySelector('[data-testid="chat-model"]')).toBeNull()
      expect(element.querySelector('[data-testid="chat-external-model"]')?.textContent).toBe(
        'This agent runs only in the desktop app.',
      )
      expect(element.querySelector('[data-testid="chat-external-exec"]')).toBeNull()
      await openMode(element.querySelector('[data-testid="chat-mode"]')!)
      expect(modeItem('chat-mode-claude')?.hasAttribute('data-disabled')).toBe(true)
    } finally {
      await unmount(element, root)
    }
  })

  it('shows the resolved executable and disables send when it is missing', async () => {
    register(VaultService)
    register(SettingsService)
    register(ChatService)
    setAgentProcessHostForTests({
      available: true,
      spawn: () => Promise.reject(new Error('unused')),
    })
    delete (window as { __STRIDE_ELECTRON__?: unknown }).__STRIDE_ELECTRON__
    const vault = resolve(VaultService)
    const chat = resolve(ChatService)
    const settings = resolve(SettingsService)
    settings.form = {
      ...settings.form,
      agent: {
        ...settings.form.agent,
        executables: { grok: null, claude: null, codex: null },
      },
    }
    vault.agentMode = 'claude'
    chat.externalExec = null
    const { host: element, root } = host()
    try {
      await render(root, <ChatPanel />)
      expect(element.querySelector('[data-testid="chat-external-exec"]')?.textContent).toBe('Checking the executable…')
      expect((element.querySelector('[data-testid="chat-send"]') as HTMLButtonElement).disabled).toBe(false)

      await act(async () => {
        chat.externalExec = { mode: 'claude', found: false, resolved: '', command: 'claude' }
      })
      expect(element.querySelector('[data-testid="chat-external-exec"]')?.textContent).toBe(
        'That executable was not found.',
      )
      expect((element.querySelector('[data-testid="chat-send"]') as HTMLButtonElement).disabled).toBe(true)

      await act(async () => {
        chat.externalExec = { mode: 'claude', found: true, resolved: '/opt/bin/claude', command: 'claude' }
      })
      const text = element.querySelector('[data-testid="chat-external-exec"]')?.textContent ?? ''
      expect(text).toContain('claude')
      expect(text).toContain('/opt/bin/claude')
      expect((element.querySelector('[data-testid="chat-send"]') as HTMLButtonElement).disabled).toBe(false)
    } finally {
      setAgentProcessHostForTests(null)
      await unmount(element, root)
    }
  })

  it('renders undo when the assistant message is marked undoable', async () => {
    register(VaultService)
    register(SettingsService)
    register(ChatService)
    const chat = resolve(ChatService)
    chat.session = blankChatSession('ses_undo')
    chat.session.messages = [
      { id: 'user-1', role: 'user', text: 'hi', thinking: '', tools: [] },
      { id: 'asst-1', role: 'assistant', text: 'done', thinking: '', tools: [] },
    ]
    chat.undoableTurnIds = ['asst-1']
    chat.undoSkippedTurnIds = ['asst-1']
    const { host: element, root } = host()
    try {
      await render(root, <ChatPanel />)
      expect(element.querySelectorAll('[data-testid="chat-undo-turn"]')).toHaveLength(1)
      expect(element.querySelector('[data-testid="chat-undo-turn"]')?.textContent).toBe('Undo turn')
      expect(element.querySelector('[data-testid="chat-undo-skipped"]')?.textContent).toBe('Skipped')
    } finally {
      await unmount(element, root)
    }
  })
})
