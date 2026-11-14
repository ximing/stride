import { has, register, resolve } from '@rabjs/react'
import { MemorySecretsStore } from '@stride/platform'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resetSecretsStore, setSecretsStore, SETTINGS_STORAGE_KEY, SettingsService } from './settings.service'

const detected = vi.hoisted(() => ({
  paths: {
    grok: '/Users/me/.grok/bin/grok',
    claude: '/Users/me/.local/bin/claude',
    codex: '/Users/me/.local/share/fnm/node-versions/v26.7.0/installation/bin/codex',
  } as { grok: string | null; claude: string | null; codex: string | null },
}))

vi.mock('@stride/electron-api', () => ({
  whichAgents: async () => detected.paths,
}))

function desktop(on: boolean) {
  const target = window as { __STRIDE_ELECTRON__?: object }
  if (on) target.__STRIDE_ELECTRON__ = {}
  else delete target.__STRIDE_ELECTRON__
}

describe('agent executable detection', () => {
  afterEach(() => {
    desktop(false)
    localStorage.removeItem(SETTINGS_STORAGE_KEY)
    resetSecretsStore()
  })

  function setup() {
    if (!has(SettingsService)) register(SettingsService)
    setSecretsStore(new MemorySecretsStore())
    const settings = resolve(SettingsService)
    settings.form = {
      ...settings.form,
      agent: {
        maxTurns: 200,
        memoryEnabled: true,
        memoryModelId: '',
        executables: { grok: null, claude: null, codex: null },
      },
    }
    Object.assign(settings, { loaded: true, detectTask: null, detectAfterLoad: false })
    return settings
  }

  it('fills only unset paths and saves them', async () => {
    desktop(true)
    const settings = setup()
    settings.form = {
      ...settings.form,
      agent: {
        ...settings.form.agent,
        executables: { grok: '/custom/grok', claude: null, codex: '' },
      },
    }
    await settings.fillDetectedExecutables()
    expect(settings.form.agent.executables).toEqual({
      grok: '/custom/grok',
      claude: detected.paths.claude,
      codex: '',
    })
    const saved = JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) ?? '{}') as {
      agent: { executables: { grok: string; claude: string; codex: string } }
    }
    expect(saved.agent.executables).toEqual(settings.form.agent.executables)
  })

  it('leaves unset paths unset when detection finds nothing', async () => {
    desktop(true)
    detected.paths = { grok: null, claude: null, codex: null }
    const settings = setup()
    await settings.fillDetectedExecutables()
    expect(settings.form.agent.executables).toEqual({ grok: null, claude: null, codex: null })
    expect(localStorage.getItem(SETTINGS_STORAGE_KEY)).toBeNull()
    detected.paths = {
      grok: '/Users/me/.grok/bin/grok',
      claude: '/Users/me/.local/bin/claude',
      codex: '/Users/me/.local/share/fnm/node-versions/v26.7.0/installation/bin/codex',
    }
  })

  it('prefills paths missing from a saved settings file', async () => {
    desktop(true)
    detected.paths = {
      grok: '/Users/me/.grok/bin/grok',
      claude: '/Users/me/.local/bin/claude',
      codex: '/Users/me/.local/share/fnm/node-versions/v26.7.0/installation/bin/codex',
    }
    const settings = setup()
    Object.assign(settings, { loaded: false })
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({
      agent: { maxTurns: 12, memoryEnabled: false },
    }))
    await settings.load()
    await settings.fillDetectedExecutables()
    expect(settings.form.agent.maxTurns).toBe(12)
    expect(settings.form.agent.memoryEnabled).toBe(false)
    expect(settings.form.agent.executables).toEqual(detected.paths)
    const saved = JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) ?? '{}') as {
      agent: { maxTurns: number; executables: typeof detected.paths }
    }
    expect(saved.agent.maxTurns).toBe(12)
    expect(saved.agent.executables).toEqual(detected.paths)
  })
})
