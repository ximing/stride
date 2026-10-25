import { describe, expect, it } from 'vitest'
import { MemoryFileSystem, MemorySecretsStore } from '@stride/platform'
import {
  defaultLlmSettings,
  defaultSettings,
  publicSettings,
  readSettings,
  writeSettings,
} from './settings.ts'

describe('settings page sections schema (T7.1)', () => {
  it('ships defaults for appearance, editor, updates, and privacy', () => {
    const defaults = defaultSettings()
    expect(defaults.appearance).toEqual({ noteWidth: 'standard', fontSize: 16, fontFamily: '' })
    expect(defaults.editor).toEqual({ autosaveDebounceMs: 350 })
    expect(defaults.updates).toEqual({ channel: 'stable', autoCheck: true })
    expect(defaults.privacy).toEqual({ telemetryEnabled: false })
  })

  it('fills defaults when an old settings JSON lacks the new sections', async () => {
    const files = new MemoryFileSystem('/virtual/settings')
    const secrets = new MemorySecretsStore()
    await files.writeText('legacy.json', JSON.stringify({
      embedding: { endpoint: '', model: '', keySeal: '', keyMask: '', dim: 4 },
      llmConfigs: [],
      releasesUrl: '',
      gitEnabled: true,
    }))
    const loaded = await readSettings(files, 'legacy.json', secrets)
    expect(loaded.appearance).toEqual(defaultSettings().appearance)
    expect(loaded.editor).toEqual(defaultSettings().editor)
    expect(loaded.updates).toEqual(defaultSettings().updates)
    expect(loaded.privacy).toEqual(defaultSettings().privacy)
  })

  it('round-trips the new sections through write/read without losing fields', async () => {
    const files = new MemoryFileSystem('/virtual/settings')
    const secrets = new MemorySecretsStore()
    const settings = defaultSettings()
    settings.appearance = { noteWidth: 'wide', fontSize: 18, fontFamily: 'Songti SC' }
    settings.editor = { autosaveDebounceMs: 800 }
    settings.updates = { channel: 'beta', autoCheck: false }
    settings.privacy = { telemetryEnabled: true }
    await writeSettings(files, 'roundtrip.json', settings, secrets)
    const raw = JSON.parse(await files.readText('roundtrip.json'))
    expect(raw.appearance).toEqual({ noteWidth: 'wide', fontSize: 18, fontFamily: 'Songti SC' })
    expect(raw.editor).toEqual({ autosaveDebounceMs: 800 })
    expect(raw.updates).toEqual({ channel: 'beta', autoCheck: false })
    expect(raw.privacy).toEqual({ telemetryEnabled: true })
    const loaded = await readSettings(files, 'roundtrip.json', secrets)
    expect(loaded.appearance).toEqual(settings.appearance)
    expect(loaded.editor).toEqual(settings.editor)
    expect(loaded.updates).toEqual(settings.updates)
    expect(loaded.privacy).toEqual(settings.privacy)
    // Public view carries the same non-secret sections.
    const pub = publicSettings(loaded)
    expect(pub.appearance).toEqual(settings.appearance)
    expect(pub.editor).toEqual(settings.editor)
    expect(pub.updates).toEqual(settings.updates)
    expect(pub.privacy).toEqual(settings.privacy)
  })

  it('falls back to defaults for malformed section values', async () => {
    const files = new MemoryFileSystem('/virtual/settings')
    const secrets = new MemorySecretsStore()
    await files.writeText('bad.json', JSON.stringify({
      appearance: { noteWidth: 'huge', fontSize: -3, fontFamily: 'Bad;Font' },
      editor: { autosaveDebounceMs: 'fast' },
      updates: { channel: 'nightly', autoCheck: 'yes' },
      privacy: { telemetryEnabled: 'no' },
    }))
    const loaded = await readSettings(files, 'bad.json', secrets)
    expect(loaded.appearance).toEqual({ noteWidth: 'standard', fontSize: 16, fontFamily: '' })
    expect(loaded.editor).toEqual({ autosaveDebounceMs: 350 })
    expect(loaded.updates).toEqual({ channel: 'stable', autoCheck: true })
    expect(loaded.privacy).toEqual({ telemetryEnabled: false })
  })

  it('keeps explicit opt-outs: autoCheck false and telemetryEnabled true survive', async () => {
    const files = new MemoryFileSystem('/virtual/settings')
    const secrets = new MemorySecretsStore()
    await files.writeText('flags.json', JSON.stringify({
      updates: { channel: 'beta', autoCheck: false },
      privacy: { telemetryEnabled: true },
    }))
    const loaded = await readSettings(files, 'flags.json', secrets)
    expect(loaded.updates).toEqual({ channel: 'beta', autoCheck: false })
    expect(loaded.privacy).toEqual({ telemetryEnabled: true })
  })
})

describe('llm settings', () => {
  it('migrates a legacy sealed llm record and collapses extra defaults', async () => {
    const files = new MemoryFileSystem('/virtual/settings')
    const secrets = new MemorySecretsStore()
    const key = 'sk-legacy-llm-key-value'
    await files.writeText('legacy.json', `${JSON.stringify({
      embedding: { endpoint: '', model: '', keySeal: '', keyMask: '', dim: 4 },
      llm: {
        provider: 'openai',
        model: 'gpt-4o-mini',
        baseUrl: '',
        keySeal: await secrets.seal(key),
        keyMask: '••••alue',
      },
      releasesUrl: '',
    })}\n`)
    const legacy = await readSettings(files, 'legacy.json', secrets)
    expect(legacy.llmConfigs).toEqual([{
      id: 'legacy',
      name: 'LLM',
      provider: 'openai',
      model: 'gpt-4o-mini',
      baseUrl: '',
      apiKey: key,
      isDefault: true,
    }])
    expect(defaultLlmSettings(legacy)?.baseUrl).toBe('https://api.openai.com/v1')

    await files.writeText('unknown.json', JSON.stringify({
      llm: { provider: 'fixture', model: 'm', baseUrl: 'http://127.0.0.1/v1', keySeal: '', keyMask: '' },
    }))
    const unknown = await readSettings(files, 'unknown.json', secrets)
    expect(unknown.llmConfigs[0]).toMatchObject({ id: 'legacy', provider: 'custom', model: 'm', isDefault: true })

    await files.writeText('defaults.json', JSON.stringify({
      llmConfigs: [
        { id: '', name: 'First', provider: 'openai', model: 'gpt-4o-mini', baseUrl: '', keySeal: '', keyMask: '', isDefault: true },
        { id: 'b', name: 'Second', provider: 'deepseek', model: 'deepseek-chat', baseUrl: '', keySeal: '', keyMask: '', isDefault: true },
      ],
    }))
    const collapsed = await readSettings(files, 'defaults.json', secrets)
    expect(collapsed.llmConfigs.map((config) => config.id)).toEqual(['legacy-0', 'b'])
    expect(collapsed.llmConfigs.map((config) => config.isDefault)).toEqual([true, false])
    expect(defaultSettings().llmConfigs).toEqual([])
  })

  it('round-trips two sealed keys and leaves them out of the file', async () => {
    const files = new MemoryFileSystem('/virtual/settings')
    const secrets = new MemorySecretsStore()
    const keyA = 'sk-stride-llm-alpha-key'
    const keyB = 'sk-stride-llm-beta-key'
    await writeSettings(files, 'two.json', {
      ...defaultSettings(),
      embedding: { endpoint: '', model: '', apiKey: '', dim: 4 },
      llmConfigs: [
        { id: 'a', name: 'A', provider: 'openai', model: 'gpt-4o-mini', baseUrl: '', apiKey: keyA, isDefault: true },
        { id: 'b', name: 'B', provider: 'deepseek', model: 'deepseek-chat', baseUrl: 'https://api.deepseek.com', apiKey: keyB, isDefault: false },
      ],
      releasesUrl: '',
    }, secrets)
    const text = await files.readText('two.json')
    expect(text.includes(keyA)).toBe(false)
    expect(text.includes(keyB)).toBe(false)
    expect(text.includes('"apiKey"')).toBe(false)
    expect(text.includes('keySeal')).toBe(true)
    const loaded = await readSettings(files, 'two.json', secrets)
    expect(loaded.llmConfigs.map((config) => config.apiKey)).toEqual([keyA, keyB])
    expect(defaultLlmSettings(loaded)?.apiKey).toBe(keyA)
    expect(defaultLlmSettings(loaded)?.provider).toBe('openai')
  })

  it('round-trips gitEnabled and keeps a missing flag on', async () => {
    const files = new MemoryFileSystem('/virtual/settings')
    const secrets = new MemorySecretsStore()
    await writeSettings(files, 'off.json', { ...defaultSettings(), gitEnabled: false }, secrets)
    const off = await readSettings(files, 'off.json', secrets)
    expect(off.gitEnabled).toBe(false)
    expect(publicSettings(off).gitEnabled).toBe(false)
    expect(JSON.parse(await files.readText('off.json')).gitEnabled).toBe(false)

    await files.writeText('missing.json', JSON.stringify({
      embedding: { endpoint: '', model: '', keySeal: '', keyMask: '', dim: 4 },
      releasesUrl: '',
    }))
    const missing = await readSettings(files, 'missing.json', secrets)
    expect(missing.gitEnabled).toBe(true)
    expect(defaultSettings().gitEnabled).toBe(true)

    await files.writeText('other.json', JSON.stringify({ gitEnabled: 'false' }))
    expect((await readSettings(files, 'other.json', secrets)).gitEnabled).toBe(true)
    expect(missing.autoSyncMinutes).toBe(0)
    expect(defaultSettings().autoSyncMinutes).toBe(5)
    expect(defaultSettings().autoGitEnabled).toBe(true)
    expect(defaultSettings().autoGitIdleSeconds).toBe(60)
    expect(defaultSettings().autoGitBlurSeconds).toBe(5)
    expect(missing.autoGitEnabled).toBe(false)
    expect(missing.autoGitIdleSeconds).toBe(0)
    expect(missing.autoGitBlurSeconds).toBe(0)
    await files.writeText('bad-interval.json', JSON.stringify({ autoSyncMinutes: '5' }))
    expect((await readSettings(files, 'bad-interval.json', secrets)).autoSyncMinutes).toBe(0)
    await files.writeText('bad-autogit.json', JSON.stringify({ autoGitIdleSeconds: '5', autoGitBlurSeconds: '5', autoGitEnabled: 'yes' }))
    const badAutoGit = await readSettings(files, 'bad-autogit.json', secrets)
    expect(badAutoGit.autoGitEnabled).toBe(false)
    expect(badAutoGit.autoGitIdleSeconds).toBe(0)
    expect(badAutoGit.autoGitBlurSeconds).toBe(0)
    await writeSettings(files, 'five.json', { ...defaultSettings(), autoSyncMinutes: 5 }, secrets)
    expect((await readSettings(files, 'five.json', secrets)).autoSyncMinutes).toBe(5)
    await writeSettings(files, 'autogit.json', { ...defaultSettings(), autoGitEnabled: true, autoGitIdleSeconds: 30, autoGitBlurSeconds: 10 }, secrets)
    const autoGit = await readSettings(files, 'autogit.json', secrets)
    expect(autoGit.autoGitEnabled).toBe(true)
    expect(autoGit.autoGitIdleSeconds).toBe(30)
    expect(autoGit.autoGitBlurSeconds).toBe(10)
  })
})
