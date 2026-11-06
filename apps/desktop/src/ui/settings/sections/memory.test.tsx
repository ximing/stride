import { has, register, resolve } from '@rabjs/react'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
import { MemoryAppDataStore, MemorySecretsStore } from '@stride/platform'
import {
  emptyMemoryIndex,
  serializeMemoryEntry,
  serializeMemoryIndex,
  upsertIndexEntry,
  vaultStorageKey,
  type MemoryIndexEntry,
} from '@stride/core'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ChatService } from '../../../services/chat/chat.service'
import { resetAppDataStore, setAppDataStore } from '../../../services/platform/app-data'
import { resetSecretsStore, setSecretsStore, SETTINGS_STORAGE_KEY, SettingsService } from '../../../services/settings/settings.service'
import { VaultService } from '../../../services/vault/vault.service'
import { MemorySection } from './memory'

// jsdom lacks the pointer/scroll APIs Radix Select touches when it opens.
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {}
}
for (const method of ['hasPointerCapture', 'setPointerCapture', 'releasePointerCapture'] as const) {
  if (!(method in Element.prototype)) {
    ;(Element.prototype as unknown as Record<string, unknown>)[method] = () => false
  }
}

function defaultForm() {
  return {
    embedding: { endpoint: '', model: '', keyMask: '', dim: 4 },
    llmConfigs: [
      { id: 'cfg-a', name: 'Primary', provider: 'openai', model: 'gpt-4o-mini', baseUrl: '', keyMask: '', isDefault: true },
      { id: 'cfg-b', name: 'Backup', provider: 'deepseek', model: 'deepseek-chat', baseUrl: '', keyMask: '', isDefault: false },
    ],
    releasesUrl: '',
    gitEnabled: true,
    autoSyncMinutes: 0,
    autoGitEnabled: false,
    autoGitIdleSeconds: 0,
    autoGitBlurSeconds: 0,
    appearance: { noteWidth: 'standard' as const, fontSize: 15, fontFamily: '' },
    editor: { autosaveDebounceMs: 350 },
    agent: { maxTurns: 200, memoryEnabled: true, memoryModelId: '' },
    updates: { channel: 'stable' as const, autoCheck: true },
    privacy: { telemetryEnabled: false },
  }
}

function storedSettings(): Record<string, any> | null {
  const raw = localStorage.getItem(SETTINGS_STORAGE_KEY)
  return raw ? JSON.parse(raw) : null
}

describe('memory settings section', () => {
  let host: HTMLDivElement | null = null
  let root: Root | null = null

  beforeEach(() => {
    if (!has(SettingsService)) register(SettingsService)
    setSecretsStore(new MemorySecretsStore())
    const settings = resolve(SettingsService)
    settings.form = defaultForm()
    settings.notice = ''
  })

  afterEach(async () => {
    if (root) await act(async () => root?.unmount())
    host?.remove()
    root = null
    host = null
    localStorage.removeItem(SETTINGS_STORAGE_KEY)
    resetSecretsStore()
    const settings = resolve(SettingsService)
    settings.form = defaultForm()
    settings.notice = ''
  })

  async function mount() {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => {
      root?.render(<MemorySection />)
    })
  }

  it('toggles long-term memory and persists the switch', async () => {
    await mount()
    const toggle = document.querySelector('[data-testid="memory-enabled"]') as HTMLInputElement
    expect(toggle.checked).toBe(true)
    await act(async () => {
      toggle.click()
    })
    const settings = resolve(SettingsService)
    expect(settings.form.agent.memoryEnabled).toBe(false)
    // The switch saves immediately.
    expect(storedSettings()?.agent?.memoryEnabled).toBe(false)
    // The model picker disables with the master switch.
    expect((document.querySelector('[data-testid="memory-model"]') as HTMLButtonElement).disabled).toBe(true)
  })

  it('offers every LLM config plus the chat-default fallback', async () => {
    await mount()
    const trigger = document.querySelector('[data-testid="memory-model"]') as HTMLButtonElement
    expect(trigger.textContent).toContain('Follow chat default')
    await act(async () => {
      trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(document.querySelector('[data-testid="memory-model-default"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="memory-model-cfg-a"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="memory-model-cfg-b"]')).not.toBeNull()

    await act(async () => {
      document.querySelector('[data-testid="memory-model-cfg-b"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const settings = resolve(SettingsService)
    expect(settings.form.agent.memoryModelId).toBe('cfg-b')
    expect(storedSettings()?.agent?.memoryModelId).toBe('cfg-b')
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

describe('memory settings entry list', () => {
  let host: HTMLDivElement | null = null
  let root: Root | null = null
  let store: MemoryAppDataStore

  beforeEach(() => {
    if (!has(SettingsService)) register(SettingsService)
    if (!has(VaultService)) register(VaultService)
    if (!has(ChatService)) register(ChatService)
    setSecretsStore(new MemorySecretsStore())
    resolve(SettingsService).form = defaultForm()
    resolve(VaultService).activeVaultId = 'vault-1'
    store = new MemoryAppDataStore()
    setAppDataStore({ store, persistent: true })
  })

  afterEach(async () => {
    if (root) await act(async () => root?.unmount())
    host?.remove()
    root = null
    host = null
    resetAppDataStore()
    resolve(VaultService).activeVaultId = ''
    localStorage.removeItem(SETTINGS_STORAGE_KEY)
    resetSecretsStore()
  })

  async function mount() {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => {
      root?.render(<MemorySection />)
    })
    // The list loads asynchronously after mount; flush the read.
    await act(async () => Promise.resolve())
  }

  async function seed() {
    const key = vaultStorageKey('vault-1')
    const project = upsertIndexEntry(
      emptyMemoryIndex('2026-11-06T09:00:00.000Z'),
      memoryIndexEntry({ id: 'mem_p', title: 'Reply language', summary: 'Answer in Chinese', kind: 'preference' }),
    )
    const globalIndex = upsertIndexEntry(
      emptyMemoryIndex('2026-11-06T09:00:00.000Z'),
      memoryIndexEntry({ id: 'mem_g', title: 'Commit style', summary: 'Imperative subject', kind: 'decision' }),
    )
    await store.writeText(`memory/${key}/index.json`, serializeMemoryIndex(project))
    await store.writeText('memory/_global/index.json', serializeMemoryIndex(globalIndex))
    await store.writeText(
      `memory/${key}/entries/mem_p.json`,
      serializeMemoryEntry({
        format: 1,
        id: 'mem_p',
        kind: 'preference',
        title: 'Reply language',
        content: 'The user wants technical discussions in Chinese.',
        tags: [],
        createdAt: '2026-11-06T09:00:00.000Z',
        updatedAt: '2026-11-06T09:00:00.000Z',
        source: { sessionId: '', noteIds: [] },
        status: 'active',
      }),
    )
  }

  it('shows project and global entries with kind and summary', async () => {
    await seed()
    await mount()
    expect(document.querySelector('[data-testid="memory-list"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="memory-group-project"]')?.textContent).toContain('Reply language')
    expect(document.querySelector('[data-testid="memory-group-global"]')?.textContent).toContain('Commit style')
    expect(document.querySelector('[data-testid="memory-group-project"]')?.textContent).toContain('Answer in Chinese')
    expect(document.querySelector('[data-testid="memory-entry-kind"]')?.textContent).toBe('Preference')
    expect(document.querySelector('[data-testid="memory-empty"]')).toBeNull()
  })

  it('loads full content when an entry expands', async () => {
    await seed()
    await mount()
    const row = document.querySelector('[data-scope="project"] .memory-entry-summary') as HTMLButtonElement
    expect(document.querySelector('[data-testid="memory-entry-content"]')).toBeNull()
    await act(async () => {
      row.click()
    })
    await act(async () => Promise.resolve())
    expect(document.querySelector('[data-testid="memory-entry-content"]')?.textContent).toContain(
      'The user wants technical discussions in Chinese.',
    )
  })

  it('shows the empty state when nothing is remembered yet', async () => {
    await mount()
    expect(document.querySelector('[data-testid="memory-empty"]')?.textContent).toContain('No memories yet')
    expect(document.querySelector('[data-testid="memory-group-project"]')).toBeNull()
  })
})
