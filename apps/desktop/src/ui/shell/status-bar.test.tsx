import { has, register, resolve } from '@rabjs/react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { ChatService } from '../../services/chat/chat.service'
import { blankChatSession } from '../../services/chat/chat-turn'
import { GitService } from '../../services/git/git.service'
import { LAYOUT_STORAGE_KEY } from '../../services/layout/layout'
import { LayoutService } from '../../services/layout/layout.service'
import { SettingsService } from '../../services/settings/settings.service'
import { SettingsPageService } from '../../services/settings/settings-page.service'
import { UpdateCheckService } from '../../services/update/update-check'
import { VaultService } from '../../services/vault/vault.service'
import { StatusBar } from './status-bar'

const GATE = 'ERROR notes/a.stride.json: 缺少必填字段: status\n1 error(s), 0 warning(s)'

describe('status bar commit gate', () => {
  let root: Root | undefined
  let host: HTMLDivElement | undefined
  let layoutSnapshot = ''
  let previousTab: LayoutService['rightPanelTab'] = 'properties'
  let previousCollapsed = false

  afterEach(() => {
    act(() => {
      root?.unmount()
    })
    host?.remove()
    root = undefined
    host = undefined
    if (has(LayoutService)) {
      const layout = resolve(LayoutService)
      layout.rightPanelTab = previousTab
      layout.rightPanelCollapsed = previousCollapsed
    }
    if (layoutSnapshot) localStorage.setItem(LAYOUT_STORAGE_KEY, layoutSnapshot)
    else localStorage.removeItem(LAYOUT_STORAGE_KEY)
  })

  function services() {
    if (!has(VaultService)) register(VaultService)
    if (!has(GitService)) register(GitService)
    if (!has(SettingsService)) register(SettingsService)
    if (!has(SettingsPageService)) register(SettingsPageService)
    if (!has(UpdateCheckService)) register(UpdateCheckService)
    if (!has(ChatService)) register(ChatService)
    if (!has(LayoutService)) register(LayoutService)
    const git = resolve(GitService)
    const chat = resolve(ChatService)
    const layout = resolve(LayoutService)
    git.surface = 'ready'
    git.branch = 'main'
    git.busy = false
    git.conflicts = []
    git.output = ''
    chat.running = false
    chat.error = ''
    chat.draft = ''
    chat.session = blankChatSession('session-1')
    layoutSnapshot = localStorage.getItem(LAYOUT_STORAGE_KEY) ?? ''
    previousTab = layout.rightPanelTab
    previousCollapsed = layout.rightPanelCollapsed
    layout.rightPanelTab = 'git'
    return { git, chat, layout }
  }

  async function renderBar() {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => {
      root?.render(<StatusBar />)
    })
  }

  it('shows a small AI fix button only for a commit check and sends it to the agent', async () => {
    const { git, chat, layout } = services()
    git.output = 'network down'
    await renderBar()
    expect(host?.querySelector('[data-testid="statusbar-git-solve"]')).toBeNull()

    git.output = GATE
    await act(async () => {
      root?.render(<StatusBar />)
    })
    const button = host?.querySelector<HTMLButtonElement>('[data-testid="statusbar-git-solve"]')
    expect(button?.textContent).toContain('Fix with AI')
    expect(button?.querySelector('svg')).not.toBeNull()
    await act(async () => {
      button?.click()
    })
    expect(layout.rightPanelTab).toBe('chat')
    expect(chat.draft).toContain('缺少必填字段: status')
    expect(chat.draft).toContain('Do not commit or push')
    expect(chat.error).toContain('Settings')
  })
})
