import { register, resolve } from '@rabjs/react'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { ChatService } from '../../services/chat/chat.service'
import { SettingsService } from '../../services/settings/settings.service'
import { VaultService } from '../../services/vault/vault.service'
import { ChatPanel } from './chat-panel'

function host(): { host: HTMLDivElement; root: Root } {
  const element = document.createElement('div')
  document.body.appendChild(element)
  return { host: element, root: createRoot(element) }
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
      expect(element.querySelector('[data-testid="chat-mode-safe"]')).not.toBeNull()
      expect(element.querySelector('[data-testid="chat-mode-power"]')).not.toBeNull()
      expect(element.querySelector('.chat-compose')).not.toBeNull()

      await act(async () => {
        element.querySelector('[data-testid="chat-mode-power"]')?.dispatchEvent(
          new MouseEvent('mousedown', { bubbles: true, button: 0 }),
        )
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
})
