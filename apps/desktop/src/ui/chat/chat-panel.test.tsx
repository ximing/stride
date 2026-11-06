import { register, resolve } from '@rabjs/react'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryAppDataStore } from '@stride/platform'
import {
  newSessionId,
  serializeSession,
  serializeSessionMeta,
  vaultStorageKey,
  type ChatSessionFile,
  type ChatSessionMeta,
} from '@stride/core'
import { afterEach, describe, expect, it } from 'vitest'
import { CHAT_TURN_LIMIT_ERROR, ChatService } from '../../services/chat/chat.service'
import { blankChatSession } from '../../services/chat/chat-turn'
import { resetAppDataStore, setAppDataStore } from '../../services/platform/app-data'
import { SettingsService } from '../../services/settings/settings.service'
import { VaultService } from '../../services/vault/vault.service'
import { ChatPanel } from './chat-panel'

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
  chat.resetMemoryWork()
  Object.assign(chat, { vaultKeyLoaded: null })
  const settings = resolve(SettingsService)
  settings.form = { ...settings.form, llmConfigs: [] }
  const vault = resolve(VaultService)
  vault.agentMode = 'safe'
  vault.activeVaultId = ''
  resetAppDataStore()
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
})
