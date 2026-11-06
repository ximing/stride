import { register, resolve } from '@rabjs/react'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { CHAT_TURN_LIMIT_ERROR, ChatService } from '../../services/chat/chat.service'
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
  const settings = resolve(SettingsService)
  settings.form = { ...settings.form, llmConfigs: [] }
  resolve(VaultService).agentMode = 'safe'
}

describe('ChatPanel', () => {
  afterEach(() => {
    resetChat()
  })

  it('keeps new-session, model, and mode controls without a panel title', async () => {
    register(VaultService)
    register(SettingsService)
    register(ChatService)
    const { host: element, root } = host()
    try {
      await render(root, <ChatPanel />)
      const sessions = element.querySelector('.chat-sessions')
      expect(element.querySelector('.panel-heading')).toBeNull()
      expect(sessions?.querySelector('[data-testid="chat-tabs"]')).not.toBeNull()
      expect(sessions?.querySelector('[data-testid="chat-new"]')).not.toBeNull()
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

  it('shows each tool call as a collapsed bar', async () => {
    register(VaultService)
    register(SettingsService)
    register(ChatService)
    const chat = resolve(ChatService)
    chat.sessions = [{
      id: 'session-1',
      title: 'New',
      messages: [{
        role: 'assistant',
        text: 'done',
        thinking: '',
        tools: [{
          id: 'call-1',
          name: 'read_note',
          argsSummary: '{"id":"规则"}',
          resultSummary: '{"content":"Note not found"}',
          durationMs: 2,
          isError: false,
          pending: false,
        }],
      }],
    }]
    const { host: element, root } = host()
    try {
      await render(root, <ChatPanel />)
      const tool = element.querySelector('details[data-testid="chat-tool"]') as HTMLDetailsElement | null
      expect(tool).not.toBeNull()
      expect(tool?.open).toBe(false)
      expect(tool?.querySelector('[data-testid="chat-tool-name"]')?.textContent).toBe('read_note')
      expect(tool?.querySelector('[data-testid="chat-tool-duration"]')?.textContent).toBe('2 ms')
      expect(tool?.querySelector('[data-testid="chat-tool-args"]')?.textContent).toContain('规则')
    } finally {
      chat.sessions = [{ id: 'session-1', title: 'New', messages: [] }]
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
        settings.form = { ...settings.form, agent: { maxTurns: 40 } }
      })
      expect(element.querySelector('[data-testid="chat-error"]')?.textContent).toBe('Reached the 40-turn limit and stopped.')
    } finally {
      await unmount(element, root)
    }
  })
})
