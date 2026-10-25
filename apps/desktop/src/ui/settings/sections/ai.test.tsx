import { has, register, resolve } from '@rabjs/react'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
import { emptyTokenHistory, tokenUsageMonth, tokenUsageWeek } from '@stride/core'
import { MemorySecretsStore } from '@stride/platform'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetSecretsStore, setSecretsStore, SETTINGS_STORAGE_KEY, SettingsService, TOKEN_USAGE_STORAGE_KEY } from '../../../services/settings/settings.service'
import { AiSection, hasLlmErrors, llmConfigErrors } from './ai'

const originalScrollIntoView = window.HTMLElement.prototype.scrollIntoView

function defaultForm() {
  return {
    embedding: { endpoint: '', model: '', keyMask: '', dim: 4 },
    llmConfigs: [] as SettingsService['form']['llmConfigs'],
    releasesUrl: '',
    gitEnabled: true,
    autoSyncMinutes: 0,
    autoGitEnabled: false,
    autoGitIdleSeconds: 0,
    autoGitBlurSeconds: 0,
    appearance: { noteWidth: 'standard' as const, fontSize: 15, fontFamily: '' },
    editor: { autosaveDebounceMs: 350 },
    updates: { channel: 'stable' as const, autoCheck: true },
    privacy: { telemetryEnabled: false },
  }
}

function resetSettings() {
  const settings = resolve(SettingsService)
  settings.form = defaultForm()
  settings.embeddingKey = ''
  settings.llmKeyDrafts = {}
  settings.selectedLlmId = ''
  settings.setEmbeddingDim('4')
  settings.embeddingTestResult = ''
  settings.llmTestResult = ''
  settings.notice = ''
  settings.tokenHistory = emptyTokenHistory()
  settings.usageVaultOpen = false
  Object.assign(settings, {
    memoryEmbeddingKey: '',
    memoryLlmKeys: {},
    loaded: false,
    loadTask: null,
    usageFs: null,
    usageChain: Promise.resolve(),
    pendingUsage: [],
  })
  localStorage.removeItem(TOKEN_USAGE_STORAGE_KEY)
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

async function selectOption(testId: string, label: string) {
  const trigger = document.querySelector(`[data-testid="${testId}"]`) as HTMLButtonElement
  await act(async () => {
    trigger.click()
  })
  const option = [...document.querySelectorAll('[role="option"]')].find((item) => item.textContent === label)
  expect(option, `Missing ${label} option`).not.toBeNull()
  await act(async () => {
    ;(option as HTMLElement).click()
  })
}

function field(testId: string): HTMLInputElement {
  return document.querySelector(`[data-testid="${testId}"]`) as HTMLInputElement
}

function button(testId: string): HTMLButtonElement {
  return document.querySelector(`[data-testid="${testId}"]`) as HTMLButtonElement
}

// save() seals keys via WebCrypto, which settles on the event loop, not the
// microtask queue — poll until the tracked loading flag drops.
async function clickSave() {
  const settings = resolve(SettingsService)
  await act(async () => {
    button('settings-ai-save').click()
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 0))
  })
  await act(async () => {
    for (let index = 0; index < 200 && settings.$model.save.loading; index++) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10))
    }
  })
}

describe('ai settings section', () => {
  let host: HTMLDivElement | null = null
  let root: Root | null = null

  beforeEach(() => {
    window.HTMLElement.prototype.scrollIntoView = vi.fn()
    if (!has(SettingsService)) register(SettingsService)
    setSecretsStore(new MemorySecretsStore())
    resetSettings()
  })

  afterEach(async () => {
    if (root) await act(async () => root?.unmount())
    host?.remove()
    root = null
    host = null
    vi.unstubAllGlobals()
    if (originalScrollIntoView) window.HTMLElement.prototype.scrollIntoView = originalScrollIntoView
    else Reflect.deleteProperty(window.HTMLElement.prototype, 'scrollIntoView')
    localStorage.removeItem(SETTINGS_STORAGE_KEY)
    localStorage.removeItem(TOKEN_USAGE_STORAGE_KEY)
    resetSettings()
    resetSecretsStore()
  })

  async function mount() {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => {
      root?.render(<AiSection />)
    })
  }

  it('renders stored configs after load with the mask as placeholder, never the key', async () => {
    const settings = resolve(SettingsService)
    settings.addLlmConfig()
    const first = settings.selectedLlmId
    settings.patchLlmConfig({ name: 'Primary' })
    settings.llmKeyDrafts = { [first]: 'sk-stride-ai-alpha-key' }
    settings.addLlmConfig()
    const second = settings.selectedLlmId
    settings.patchLlmConfig({ name: 'Backup', provider: 'deepseek' })
    settings.llmKeyDrafts = { ...settings.llmKeyDrafts, [second]: 'sk-stride-ai-beta-key' }
    await settings.save()
    await settings.load()

    await mount()
    const rows = [...document.querySelectorAll('.settings-ai-row')]
    expect(rows).toHaveLength(2)
    expect(rows[0]?.textContent).toContain('Primary')
    expect(rows[0]?.textContent).toContain('Default')
    expect(rows[1]?.textContent).toContain('Backup')
    expect(rows[1]?.textContent).toContain('DeepSeek')

    // First config is selected after load (it is the default).
    expect(field('llm-name').value).toBe('Primary')
    expect(field('llm-key').value).toBe('')
    expect(field('llm-key').placeholder).toBe('••••-key')
    expect(field('llm-base-url').placeholder).toBe('https://api.openai.com/v1')

    const stored = localStorage.getItem(SETTINGS_STORAGE_KEY) ?? ''
    expect(stored).not.toContain('sk-stride-ai-alpha-key')
    expect(stored).not.toContain('sk-stride-ai-beta-key')
  })

  it('migrates a legacy single llm config into the list untouched', async () => {
    const secrets = new MemorySecretsStore()
    setSecretsStore(secrets)
    const keySeal = await secrets.seal('sk-stride-legacy-key')
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({
      llm: { provider: 'openai', model: 'gpt-4o-mini', baseUrl: '', keySeal },
      embedding: { endpoint: '', model: '', keySeal: '', keyMask: '', dim: 4 },
    }))
    const settings = resolve(SettingsService)
    await settings.load()

    await mount()
    const rows = [...document.querySelectorAll('.settings-ai-row')]
    expect(rows).toHaveLength(1)
    expect(rows[0]?.textContent).toContain('LLM')
    expect(field('llm-model').value).toBe('gpt-4o-mini')
    expect(field('llm-key').placeholder).toBe('••••-key')
    expect(settings.llmRuntime()?.apiKey).toBe('sk-stride-legacy-key')
  })

  it('adds, selects, deletes, and reassigns the default', async () => {
    const settings = resolve(SettingsService)
    await mount()
    expect(document.querySelector('[data-testid="llm-empty"]')).not.toBeNull()

    await act(async () => {
      button('llm-add').click()
    })
    const first = settings.selectedLlmId
    await act(async () => {
      button('llm-add').click()
    })
    const second = settings.selectedLlmId
    expect(second).not.toBe(first)
    expect([...document.querySelectorAll('.settings-ai-row')]).toHaveLength(2)
    expect(settings.form.llmConfigs[0]?.isDefault).toBe(true)

    // The newly added config is selected; make it the default.
    expect(button('llm-default').disabled).toBe(false)
    await act(async () => {
      button('llm-default').click()
    })
    expect(settings.form.llmConfigs.find((config) => config.id === second)?.isDefault).toBe(true)
    expect(settings.form.llmConfigs.find((config) => config.id === first)?.isDefault).toBe(false)
    expect(button('llm-default').disabled).toBe(true)

    // Selecting the other row switches the edit form; deleting it keeps the default.
    await act(async () => {
      (document.querySelector(`[data-testid="llm-row-${first}"]`) as HTMLButtonElement).click()
    })
    expect(settings.selectedLlmId).toBe(first)
    await act(async () => {
      button('llm-delete').click()
    })
    expect(settings.form.llmConfigs).toHaveLength(1)
    expect(settings.form.llmConfigs[0]?.id).toBe(second)
    expect(settings.form.llmConfigs[0]?.isDefault).toBe(true)
  })

  it('shows inline validation errors and blocks saving until fixed', async () => {
    const settings = resolve(SettingsService)
    settings.addLlmConfig()
    await mount()

    await act(async () => {
      setInputValue(field('llm-name'), '   ')
    })
    expect(document.querySelector('[data-testid="llm-error-name"]')?.textContent).toContain('Name is required')
    expect(button('settings-ai-save').disabled).toBe(true)
    expect(document.querySelector('[data-testid="settings-ai-invalid-summary"]')).not.toBeNull()

    await act(async () => {
      setInputValue(field('llm-name'), 'Primary')
      setInputValue(field('llm-base-url'), 'ftp://example.com')
    })
    expect(document.querySelector('[data-testid="llm-error-name"]')).toBeNull()
    expect(document.querySelector('[data-testid="llm-error-base-url"]')?.textContent).toContain('http')
    expect(button('settings-ai-save').disabled).toBe(true)
    expect(localStorage.getItem(SETTINGS_STORAGE_KEY)).toBeNull()

    // A custom provider has no catalog default, so the model resets to empty
    // and Base URL becomes required.
    await act(async () => {
      setInputValue(field('llm-base-url'), '')
    })
    await selectOption('llm-provider', 'Custom')
    expect(document.querySelector('[data-testid="llm-error-base-url"]')?.textContent).toContain('required')
    expect(document.querySelector('[data-testid="llm-error-model"]')?.textContent).toContain('Model is required')

    await act(async () => {
      setInputValue(field('llm-model'), 'my-model')
      setInputValue(field('llm-base-url'), 'https://llm.example.com/v1')
    })
    expect(document.querySelector('[data-testid="settings-ai-invalid-summary"]')).toBeNull()
    expect(button('settings-ai-save').disabled).toBe(false)
  })

  it('keeps the sealed key when the draft is the mask, replaces on a new value, clears on empty', async () => {
    const settings = resolve(SettingsService)
    settings.addLlmConfig()
    const id = settings.selectedLlmId
    settings.llmKeyDrafts = { [id]: 'sk-stride-ai-keep-key' }
    await settings.save()
    await settings.load()
    await mount()

    // Untouched draft keeps the stored key through a save.
    await act(async () => {
      setInputValue(field('llm-name'), 'Renamed')
    })
    await clickSave()
    expect(settings.notice).toBe('')
    expect(settings.llmRuntime()?.apiKey).toBe('sk-stride-ai-keep-key')

    // A mask-shaped draft also keeps it.
    await act(async () => {
      setInputValue(field('llm-key'), settings.form.llmConfigs[0]?.keyMask ?? '')
    })
    await clickSave()
    expect(settings.llmRuntime()?.apiKey).toBe('sk-stride-ai-keep-key')

    // A new value replaces it and is sealed on disk.
    await act(async () => {
      setInputValue(field('llm-key'), 'sk-stride-ai-replaced-key')
    })
    await clickSave()
    expect(settings.notice).toBe('')
    expect(settings.llmRuntime()?.apiKey).toBe('sk-stride-ai-replaced-key')
    expect(localStorage.getItem(SETTINGS_STORAGE_KEY) ?? '').not.toContain('sk-stride-ai-replaced-key')

    // Clearing the field drops the key.
    await act(async () => {
      setInputValue(field('llm-key'), 'x')
    })
    await act(async () => {
      setInputValue(field('llm-key'), '')
    })
    await clickSave()
    expect(settings.llmRuntime()?.apiKey).toBe('')
  })

  it('runs the connection probe and reports success and failure', async () => {
    const sse = [
      'data: {"id":"x","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"pong"},"finish_reason":null}]}',
      '',
      'data: {"id":"x","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n')
    const fetchMock = vi.fn(async () => new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } }))
    vi.stubGlobal('fetch', fetchMock)
    const settings = resolve(SettingsService)
    settings.addLlmConfig()
    settings.llmKeyDrafts = { [settings.selectedLlmId]: 'sk-stride-ai-test-key' }
    await mount()

    await act(async () => {
      button('llm-test').click()
    })
    expect(document.querySelector('[data-testid="llm-test-result"]')?.textContent).toBe('Connection successful.')
    expect(fetchMock).toHaveBeenCalled()

    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 401 }))
    await act(async () => {
      button('llm-test').click()
    })
    const result = document.querySelector('[data-testid="llm-test-result"]')
    expect(result?.textContent).not.toBe('Connection successful.')
    expect(result?.className).toBe('settings-ai-test-err')
  })

  it('llmConfigErrors validates required fields and base URL format', () => {
    const base = { id: 'x', name: 'A', provider: 'openai', model: 'gpt-4o-mini', baseUrl: '', keyMask: '', isDefault: true }
    expect(hasLlmErrors(llmConfigErrors(base))).toBe(false)
    expect(llmConfigErrors({ ...base, name: ' ' }).name).toBeTruthy()
    expect(llmConfigErrors({ ...base, model: '' }).model).toBeTruthy()
    expect(llmConfigErrors({ ...base, baseUrl: 'notaurl' }).baseUrl).toBeTruthy()
    expect(llmConfigErrors({ ...base, provider: 'custom' }).baseUrl).toBeTruthy()
    expect(hasLlmErrors(llmConfigErrors({ ...base, provider: 'custom', baseUrl: 'https://x.dev' }))).toBe(false)
  })

  it('asks for a vault before usage can be stored', async () => {
    await mount()
    expect(document.querySelector('[data-testid="token-usage"] .settings-ai-meta')?.textContent).toBe('Open a vault to record usage in the repository.')
    expect(document.querySelector('[data-testid="token-usage-empty"]')).toBeNull()
  })

  it('shows an empty token usage state before any calls', async () => {
    resolve(SettingsService).usageVaultOpen = true
    await mount()
    expect(document.querySelector('[data-testid="token-usage-empty"]')?.textContent).toBe('No token usage yet.')
  })

  it('lists token usage by model, week, and month', async () => {
    const settings = resolve(SettingsService)
    settings.usageVaultOpen = true
    settings.tokenHistory = {
      days: [
        { date: '2026-09-15', model: 'deepseek-chat', input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15, requests: 1 },
        { date: '2026-10-22', model: 'gpt-4o-mini', input: 1200, output: 300, cacheRead: 0, cacheWrite: 0, total: 1500, requests: 2 },
      ],
    }
    await mount()
    const rows = [...document.querySelectorAll('[data-testid="token-usage-row"]')]
    expect(rows.map((row) => row.getAttribute('data-model'))).toEqual(['gpt-4o-mini', 'deepseek-chat'])
    expect(document.querySelector('[data-testid="token-usage-summary"]')?.textContent?.replace(/,/g, '')).toContain('1515')

    const weekTab = document.querySelector('[data-testid="token-usage-grain-week"]') as HTMLButtonElement
    await act(async () => {
      weekTab.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
      weekTab.click()
    })
    const laterWeek = tokenUsageWeek('2026-10-22')
    const earlierWeek = tokenUsageWeek('2026-09-15')
    const trend = [...document.querySelectorAll('[data-testid="token-usage-trend"]')]
    expect(trend.map((row) => row.getAttribute('data-period'))).toEqual([earlierWeek, laterWeek])
    expect(trend[1]?.getAttribute('aria-pressed')).toBe('true')
    expect(document.querySelector('[data-testid="token-usage-period"]')?.textContent).toBe(laterWeek)
    expect([...document.querySelectorAll('[data-testid="token-usage-row"]')].map((row) => row.getAttribute('data-model'))).toEqual(['gpt-4o-mini'])

    await act(async () => {
      ;(trend[0] as HTMLButtonElement).click()
    })
    expect(document.querySelector('[data-testid="token-usage-period"]')?.textContent).toBe(earlierWeek)
    expect([...document.querySelectorAll('[data-testid="token-usage-row"]')].map((row) => row.getAttribute('data-model'))).toEqual(['deepseek-chat'])

    const monthTab = document.querySelector('[data-testid="token-usage-grain-month"]') as HTMLButtonElement
    await act(async () => {
      monthTab.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
      monthTab.click()
    })
    expect([...document.querySelectorAll('[data-testid="token-usage-trend"]')].map((row) => row.getAttribute('data-period'))).toEqual([
      tokenUsageMonth('2026-09-15'),
      tokenUsageMonth('2026-10-22'),
    ])
    expect(document.querySelector('[data-testid="token-usage-period"]')?.textContent).toBe('2026-10')
  })
})
