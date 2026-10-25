import { has, register, resolve } from '@rabjs/react'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
import { MemorySecretsStore } from '@stride/platform'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetSecretsStore, setSecretsStore, SETTINGS_STORAGE_KEY, SettingsService } from '../../../services/settings/settings.service'
import { VaultService } from '../../../services/vault/vault.service'
import { degradedReason, EmbeddingSection, parseEmbeddingDim } from './embedding'

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
  Object.assign(settings, {
    memoryEmbeddingKey: '',
    memoryLlmKeys: {},
    loaded: false,
    loadTask: null,
  })
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
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
    button('settings-embedding-save').click()
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 0))
  })
  await act(async () => {
    for (let index = 0; index < 200 && settings.$model.save.loading; index++) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10))
    }
  })
}

function embeddingResponse(dim: number): Response {
  return new Response(JSON.stringify({
    data: [{ index: 0, embedding: Array.from({ length: dim }, (_, index) => index === 0 ? 1 : 0) }],
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}

describe('embedding settings section', () => {
  let host: HTMLDivElement | null = null
  let root: Root | null = null

  beforeEach(() => {
    if (!has(SettingsService)) register(SettingsService)
    if (!has(VaultService)) register(VaultService)
    setSecretsStore(new MemorySecretsStore())
    resetSettings()
    resolve(VaultService).searchDegraded = false
  })

  afterEach(async () => {
    if (root) await act(async () => root?.unmount())
    host?.remove()
    root = null
    host = null
    vi.unstubAllGlobals()
    localStorage.removeItem(SETTINGS_STORAGE_KEY)
    resetSettings()
    resetSecretsStore()
    resolve(VaultService).searchDegraded = false
  })

  async function mount() {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => {
      root?.render(<EmbeddingSection />)
    })
  }

  it('renders the stored endpoint, model, dim, and key mask after load', async () => {
    const settings = resolve(SettingsService)
    settings.patchEmbedding({ endpoint: 'http://127.0.0.1/v1', model: 'fixture-embed' })
    settings.setEmbeddingDim('4')
    settings.embeddingKey = 'sk-stride-embed-key'
    await settings.save()
    await settings.load()

    await mount()
    expect(field('embedding-endpoint').value).toBe('http://127.0.0.1/v1')
    expect(field('embedding-model').value).toBe('fixture-embed')
    expect(field('embedding-dim').value).toBe('4')
    expect(field('embedding-key').placeholder).toBe('••••-key')
    // The mask is echoed into the draft so an untouched save keeps the key.
    expect(field('embedding-key').value).toBe('••••-key')
    const stored = localStorage.getItem(SETTINGS_STORAGE_KEY) ?? ''
    expect(stored).not.toContain('sk-stride-embed-key')
    expect(stored).toContain('keySeal')
  })

  it('keeps the stored key when saving without touching the key field', async () => {
    const settings = resolve(SettingsService)
    settings.patchEmbedding({ endpoint: 'http://127.0.0.1/v1', model: 'fixture-embed' })
    settings.setEmbeddingDim('4')
    settings.embeddingKey = 'sk-stride-embed-keep'
    await settings.save()
    await settings.load()
    await mount()

    await act(async () => {
      setInputValue(field('embedding-model'), 'fixture-embed-2')
    })
    await clickSave()
    expect(settings.notice).toBe('')
    expect(settings.embeddingRuntime().apiKey).toBe('sk-stride-embed-keep')
    expect(settings.embeddingRuntime().model).toBe('fixture-embed-2')
    expect(localStorage.getItem(SETTINGS_STORAGE_KEY) ?? '').not.toContain('sk-stride-embed-keep')

    // Clearing the field clears the key.
    await act(async () => {
      setInputValue(field('embedding-key'), '')
    })
    await clickSave()
    expect(settings.embeddingRuntime().apiKey).toBe('')
    expect(settings.form.embedding.keyMask).toBe('')
  })

  it('rejects a malformed endpoint and blocks saving', async () => {
    const settings = resolve(SettingsService)
    await mount()
    await act(async () => {
      setInputValue(field('embedding-endpoint'), 'not a url')
    })
    expect(document.querySelector('[data-testid="embedding-error-endpoint"]')).not.toBeNull()
    expect(button('settings-embedding-save').disabled).toBe(true)
    await act(async () => {
      button('settings-embedding-save').click()
    })
    expect(localStorage.getItem(SETTINGS_STORAGE_KEY)).toBeNull()

    await act(async () => {
      setInputValue(field('embedding-endpoint'), 'https://api.openai.com/v1')
    })
    expect(document.querySelector('[data-testid="embedding-error-endpoint"]')).toBeNull()
    expect(button('settings-embedding-save').disabled).toBe(false)
    expect(settings.form.embedding.endpoint).toBe('https://api.openai.com/v1')
  })

  it('treats an illegal dim as "off" with an explanation instead of an error', async () => {
    await mount()
    await act(async () => {
      setInputValue(field('embedding-endpoint'), 'https://api.openai.com/v1')
      setInputValue(field('embedding-model'), 'text-embedding-3-small')
      setInputValue(field('embedding-dim'), 'abc')
    })
    const note = document.querySelector('[data-testid="embedding-dim-note"]')
    expect(note?.textContent).toContain('dim = 0')
    expect(button('settings-embedding-save').disabled).toBe(false)
    // The probe makes no sense without a usable dim.
    expect(button('embedding-test').disabled).toBe(true)

    await act(async () => {
      setInputValue(field('embedding-dim'), '1536')
    })
    expect(document.querySelector('[data-testid="embedding-dim-note"]')).toBeNull()
    expect(button('embedding-test').disabled).toBe(false)
  })

  it('runs the probe and reports success, dimension mismatch, and failure', async () => {
    const fetchMock = vi.fn(async () => embeddingResponse(4))
    vi.stubGlobal('fetch', fetchMock)
    const settings = resolve(SettingsService)
    settings.patchEmbedding({ endpoint: 'http://127.0.0.1/v1', model: 'fixture-embed' })
    settings.setEmbeddingDim('4')
    settings.embeddingKey = 'sk-stride-embed-test'
    await mount()

    await act(async () => {
      button('embedding-test').click()
    })
    expect(document.querySelector('[data-testid="embedding-test-result"]')?.textContent).toBe('Connection successful.')

    fetchMock.mockResolvedValueOnce(embeddingResponse(2))
    await act(async () => {
      button('embedding-test').click()
    })
    expect(document.querySelector('[data-testid="embedding-test-result"]')?.textContent).toContain('Dimension mismatch')
    expect(document.querySelector('[data-testid="embedding-test-result"]')?.textContent).toContain('expected 4, got 2')

    fetchMock.mockResolvedValueOnce(new Response('no', { status: 401 }))
    await act(async () => {
      button('embedding-test').click()
    })
    expect(document.querySelector('[data-testid="embedding-test-result"]')?.textContent).toContain('401')
  })

  it('shows the degraded banner with a reason while vector search is off', async () => {
    const settings = resolve(SettingsService)
    const vault = resolve(VaultService)
    await mount()
    expect(document.querySelector('[data-testid="embedding-degraded"]')).toBeNull()

    // Configured endpoint/model/dim but no key: degraded with the key reason.
    await act(async () => {
      settings.patchEmbedding({ endpoint: 'http://127.0.0.1/v1', model: 'fixture-embed' })
      settings.setEmbeddingDim('4')
      vault.searchDegraded = true
    })
    expect(document.querySelector('[data-testid="embedding-degraded"]')?.textContent).toContain('API key is missing')

    // Nothing configured: degraded with the unconfigured reason.
    await act(async () => {
      settings.patchEmbedding({ endpoint: '', model: '' })
      setInputValue(field('embedding-dim'), '')
    })
    expect(document.querySelector('[data-testid="embedding-degraded"]')?.textContent).toContain('not configured')

    // Fully configured and keyed: degraded means rebuild or failing requests.
    // (embeddingRuntime reads the in-memory key, not the draft.)
    await act(async () => {
      settings.patchEmbedding({ endpoint: 'http://127.0.0.1/v1', model: 'fixture-embed' })
      Object.assign(settings, { memoryEmbeddingKey: 'sk-stride-embed-live' })
      setInputValue(field('embedding-dim'), '4')
    })
    expect(document.querySelector('[data-testid="embedding-degraded"]')?.textContent).toContain('temporarily unavailable')
  })

  it('parseEmbeddingDim accepts only positive integers', () => {
    expect(parseEmbeddingDim('4')).toBe(4)
    expect(parseEmbeddingDim(' 1536 ')).toBe(1536)
    expect(parseEmbeddingDim('')).toBeNull()
    expect(parseEmbeddingDim('0')).toBeNull()
    expect(parseEmbeddingDim('-2')).toBeNull()
    expect(parseEmbeddingDim('1.5')).toBeNull()
    expect(parseEmbeddingDim('abc')).toBeNull()
  })

  it('degradedReason maps runtime states to explanations', () => {
    expect(degradedReason({ endpoint: '', model: '', apiKey: '', dim: 0, intended: false, active: false })).toContain('not configured')
    expect(degradedReason({ endpoint: 'https://x.dev', model: 'm', apiKey: '', dim: 4, intended: true, active: false })).toContain('API key is missing')
    expect(degradedReason({ endpoint: 'https://x.dev', model: 'm', apiKey: 'k', dim: 4, intended: true, active: true })).toContain('temporarily unavailable')
  })
})
