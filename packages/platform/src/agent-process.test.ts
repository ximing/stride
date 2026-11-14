import { describe, expect, it } from 'vitest'
import {
  EXTERNAL_AGENT_SPAWN,
  VAULT_CLI_RULES,
  acceptedAgentArgv,
  agentExecutableCommand,
  agentSpawnSpec,
  isExternalAgentMode,
  spawnArgsOverrideModel,
  unavailableAgentProcessHost,
} from './agent-process.ts'

describe('external agent spawn specs', () => {
  it('uses each CLI default and never passes a model override', () => {
    expect(agentSpawnSpec('claude')).toEqual(EXTERNAL_AGENT_SPAWN.claude)
    expect(EXTERNAL_AGENT_SPAWN.claude.args.slice(0, 8)).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--input-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'bypassPermissions',
    ])
    expect(EXTERNAL_AGENT_SPAWN.codex).toEqual({
      command: 'codex',
      args: ['app-server', '--listen', 'stdio://'],
    })
    expect(EXTERNAL_AGENT_SPAWN.grok).toEqual({
      command: 'grok',
      args: ['--no-auto-update', 'agent', '--always-approve', 'stdio'],
    })
    for (const mode of ['grok', 'claude', 'codex'] as const) {
      expect(isExternalAgentMode(mode)).toBe(true)
      expect(spawnArgsOverrideModel(agentSpawnSpec(mode).args)).toBe(false)
    }
    expect(isExternalAgentMode('safe')).toBe(false)
    expect(spawnArgsOverrideModel(['--model', 'gpt'])).toBe(true)
    expect(spawnArgsOverrideModel(['--model=gpt'])).toBe(true)
    expect(agentExecutableCommand('codex', null)).toBe('codex')
    expect(agentExecutableCommand('codex', '')).toBe('codex')
    expect(agentExecutableCommand('codex', '  ')).toBe('codex')
    expect(agentExecutableCommand('codex', ' /opt/codex ')).toBe('/opt/codex')
  })

  it('keeps vault rules free of secrets and paths and allowlists only the claude suffix', () => {
    expect(VAULT_CLI_RULES).toBe(
      'This directory is a Stride vault. A note is a *.stride.json file. Its doc field is TipTap JSON. Do not flatten a note into a plain-text paragraph. Do not rewrite *.stride.json with a shell or a text editor. If you change a note, edit the TipTap nodes inside doc and keep format, title, type, and properties. Do not delete or rename note files unless the user asked. Never write API keys into the vault.',
    )
    expect(VAULT_CLI_RULES.length).toBeGreaterThan(400)
    expect(VAULT_CLI_RULES.length).toBeLessThan(700)
    expect(VAULT_CLI_RULES).not.toMatch(/~|sk-|api[_-]?key|\//i)

    const claude = [...EXTERNAL_AGENT_SPAWN.claude.args]
    const withRules = [...claude, '--append-system-prompt', VAULT_CLI_RULES]
    const withResume = [...withRules, '--resume', 'sess_1.A:b']
    expect(acceptedAgentArgv('claude', claude)).toEqual(claude)
    expect(acceptedAgentArgv('claude', withRules)).toEqual(withRules)
    expect(acceptedAgentArgv('claude', withResume)).toEqual(withResume)
    expect(acceptedAgentArgv('claude', [...withRules, '--resume'])).toBeNull()
    expect(acceptedAgentArgv('claude', [...withRules, '--resume', 'bad id'])).toBeNull()
    expect(acceptedAgentArgv('claude', [...withRules, '--resume', 'a/b'])).toBeNull()
    expect(acceptedAgentArgv('claude', [...withRules, '--resume', 'a'.repeat(129)])).toBeNull()
    expect(acceptedAgentArgv('claude', [...claude, '--append-system-prompt', 'other prompt'])).toBeNull()
    expect(acceptedAgentArgv('claude', [...withResume, '--yolo'])).toBeNull()
    expect(acceptedAgentArgv('claude', [...withRules, '--model', 'opus'])).toBeNull()
    expect(acceptedAgentArgv('codex', [...EXTERNAL_AGENT_SPAWN.codex.args])).toEqual([...EXTERNAL_AGENT_SPAWN.codex.args])
    expect(acceptedAgentArgv('codex', withRules)).toBeNull()
    expect(acceptedAgentArgv('grok', [...EXTERNAL_AGENT_SPAWN.grok.args, '--resume', 'sess_1'])).toBeNull()
  })

  it('rejects spawn on the unavailable host', async () => {
    const host = unavailableAgentProcessHost()
    expect(host.available).toBe(false)
    await expect(host.spawn({ command: 'grok', args: [], cwd: '/vault' })).rejects.toThrow(
      'external-agent-unavailable',
    )
  })
})
