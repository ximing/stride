import { describe, expect, it } from 'vitest'
import { MemoryFileSystem, MemorySecretsStore } from '@stride/platform'
import {
  defaultLlmSettings,
  defaultSettings,
  publicSettings,
  readSettings,
  writeSettings,
} from './settings.ts'

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
      embedding: { endpoint: '', model: '', apiKey: '', dim: 4 },
      llmConfigs: [
        { id: 'a', name: 'A', provider: 'openai', model: 'gpt-4o-mini', baseUrl: '', apiKey: keyA, isDefault: true },
        { id: 'b', name: 'B', provider: 'deepseek', model: 'deepseek-chat', baseUrl: 'https://api.deepseek.com', apiKey: keyB, isDefault: false },
      ],
      releasesUrl: '',
      gitEnabled: true,
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
  })
})
