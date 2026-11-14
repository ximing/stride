import { has, register, resolve } from '@rabjs/react'
import { EXTERNAL_AGENT_SPAWN, MemoryAppDataStore, MemoryFileSystem, VAULT_CLI_RULES } from '@stride/platform'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatService } from './chat.service'
import { blankChatSession } from './chat-turn'
import { playChatTurn } from './chat-turn'
import { createPeerHost, type PeerHost } from './external-agent-harness'
import { setAgentProcessHostForTests, resolveAgentProcessHost } from '../platform/agent-process'
import { resolveAppDataStore } from '../platform/app-data'
import { resetAppDataStore, setAppDataStore } from '../platform/app-data'
import { ExternalAgentSession, newSessionId, parseSession, RESUME_PREFACE_PREFIX, vaultStorageKey, type ExternalActivity } from '@stride/core'
import { SettingsService } from '../settings/settings.service'
import { VaultService } from '../vault/vault.service'

vi.mock('./chat-turn', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./chat-turn')>()
  return { ...actual, playChatTurn: vi.fn() }
})

const mockedTurn = vi.mocked(playChatTurn)

function setup() {
  if (!has(VaultService)) register(VaultService)
  if (!has(SettingsService)) register(SettingsService)
  if (!has(ChatService)) register(ChatService)
  const vault = resolve(VaultService)
  const settings = resolve(SettingsService)
  const chat = resolve(ChatService)
  vault.activeVaultId = 'vault-1'
  vault.fs = new MemoryFileSystem('/vault')
  vault.agentMode = 'safe'
  settings.form = {
    ...settings.form,
    agent: { maxTurns: 200, memoryEnabled: false, memoryModelId: '', executables: { grok: null, claude: null, codex: null } },
    llmConfigs: [],
  }
  chat.draft = ''
  chat.error = ''
  chat.running = false
  chat.externalExec = null
  chat.modelId = ''
  chat.session = blankChatSession(newSessionId())
  chat.dropExternalAgent()
  Object.assign(chat, { vaultKeyLoaded: null, controller: null })
  return { vault, settings, chat }
}

async function send(chat: ChatService, text: string) {
  chat.draft = text
  await chat.send()
}

function assistantText(chat: ChatService): string[] {
  return chat.session.messages.filter((message) => message.role === 'assistant').map((message) => message.text)
}

function promptTexts(chunks: string[]): string[] {
  const texts: string[] = []
  for (const frame of writtenFrames(chunks)) {
    if (frame.type === 'user') {
      const text = (frame.message as { content?: Array<{ text?: string }> } | undefined)?.content?.[0]?.text
      if (typeof text === 'string') texts.push(text)
    }
    if (frame.method === 'turn/start') {
      const text = (frame.params as { input?: Array<{ text?: string }> } | undefined)?.input?.[0]?.text
      if (typeof text === 'string') texts.push(text)
    }
    if (frame.method === 'session/prompt') {
      const text = (frame.params as { prompt?: Array<{ text?: string }> } | undefined)?.prompt?.[0]?.text
      if (typeof text === 'string') texts.push(text)
    }
  }
  return texts
}

function writtenFrames(chunks: string[]): Array<Record<string, unknown>> {
  const frames: Array<Record<string, unknown>> = []
  for (const chunk of chunks) {
    for (const line of chunk.split('\n')) {
      if (!line.trim()) continue
      frames.push(JSON.parse(line) as Record<string, unknown>)
    }
  }
  return frames
}

const UNHANDLED_METHOD = `custom/${'n'.repeat(70)}`

function spawnArgs(mode: 'grok' | 'claude' | 'codex'): string[] {
  const args = [...EXTERNAL_AGENT_SPAWN[mode].args]
  if (mode === 'claude') args.push('--append-system-prompt', VAULT_CLI_RULES)
  return args
}

describe('external agent turns', () => {
  let host: PeerHost | null = null

  beforeEach(() => {
    setAppDataStore({ store: new MemoryAppDataStore(), persistent: true })
    mockedTurn.mockReset()
  })

  afterEach(async () => {
    resolve(ChatService).dropExternalAgent()
    await host?.killAll()
    host = null
    setAgentProcessHostForTests(null)
    const vault = resolve(VaultService)
    vault.fs = null
    vault.agentMode = 'safe'
    vault.activeVaultId = ''
    resetAppDataStore()
  })

  it('reports the browser host as unavailable and does not call the built-in turn', async () => {
    const { chat, vault } = setup()
    setAgentProcessHostForTests(null)
    expect(resolveAgentProcessHost().available).toBe(false)
    vault.agentMode = 'grok'
    await send(chat, 'hello')
    expect(chat.error).toBe('external-agent-unavailable')
    expect(chat.session.messages).toEqual([])
    expect(mockedTurn).not.toHaveBeenCalled()
  })

  for (const mode of ['grok', 'claude', 'codex'] as const) {
    it(`streams ${mode} through the shipped send path without a model override`, async () => {
      host = createPeerHost()
      setAgentProcessHostForTests(host)
      const { chat, vault } = setup()
      vault.agentMode = mode
      await send(chat, 'first')
      await send(chat, 'second')

      expect(assistantText(chat)).toEqual(['alpha', 'beta'])
      expect(chat.error).toBe('')
      expect(chat.session.modelId).toBe('')
      expect(mockedTurn).not.toHaveBeenCalled()
      expect(host.spawns).toHaveLength(1)
      expect(host.spawns[0]).toEqual({
        command: EXTERNAL_AGENT_SPAWN[mode].command,
        args: spawnArgs(mode),
        cwd: '/vault',
      })
      const written = host.writes.join('\n')
      expect(written).not.toContain('session/set_model')
      expect(written).not.toContain('session/load')
      expect(written).not.toContain('--model')
      expect(written).not.toContain('danger-full-access')
      expect(written).not.toContain('CODEX_HOME')
      expect(written).not.toMatch(/"model"\s*:/)
      if (mode === 'codex') {
        const started = writtenFrames(host.writes).find((frame) => frame.method === 'thread/start')
        expect(started?.params).toEqual({
          sandbox: 'workspace-write',
          approvalPolicy: 'on-request',
          developerInstructions: VAULT_CLI_RULES,
        })
        expect(started && 'model' in (started.params as object)).toBe(false)
      }
    })
  }

  it('starts a fresh CLI conversation after a new chat', async () => {
    host = createPeerHost()
    setAgentProcessHostForTests(host)
    const { chat, vault } = setup()
    vault.agentMode = 'claude'
    await send(chat, 'first')
    expect(assistantText(chat)).toEqual(['alpha'])
    chat.newSession()
    await send(chat, 'again')
    expect(assistantText(chat)).toEqual(['alpha'])
    expect(host.spawns).toHaveLength(2)
    expect(host.spawns.every((spec) => spec.command === 'claude')).toBe(true)
    expect(mockedTurn).not.toHaveBeenCalled()
  })

  it('starts a fresh CLI conversation when the mode changes', async () => {
    host = createPeerHost()
    setAgentProcessHostForTests(host)
    const { chat, vault } = setup()
    vault.agentMode = 'claude'
    await send(chat, 'first')
    await vault.setAgentMode('codex')
    await send(chat, 'next')
    expect(assistantText(chat)).toEqual(['alpha', 'alpha'])
    expect(host.spawns.map((spec) => spec.command)).toEqual(['claude', 'codex'])
    expect(mockedTurn).not.toHaveBeenCalled()
  })

  it('shows a missing binary without calling the built-in turn', async () => {
    host = createPeerHost({ missing: true })
    setAgentProcessHostForTests(host)
    const { chat, vault } = setup()
    vault.agentMode = 'grok'
    await send(chat, 'hello')
    expect(chat.error).toBe('external-agent-missing')
    expect(assistantText(chat)).toEqual([''])
    expect(mockedTurn).not.toHaveBeenCalled()
  })

  it('shows a failed handshake without calling the built-in turn', async () => {
    host = createPeerHost({ failHandshake: true })
    setAgentProcessHostForTests(host)
    const { chat, vault } = setup()
    vault.agentMode = 'codex'
    await send(chat, 'hello')
    expect(chat.error).toBe('external-agent-handshake')
    expect(mockedTurn).not.toHaveBeenCalled()
  })

  it('still reports aborted when the signal is already aborted', async () => {
    host = createPeerHost()
    setAgentProcessHostForTests(host)
    const session = new ExternalAgentSession(host, 'grok', '/vault')
    const controller = new AbortController()
    controller.abort()
    await expect(session.prompt('hi', controller.signal, () => undefined)).rejects.toThrow('external-agent-aborted')
    expect(host.spawns).toHaveLength(0)
    expect(mockedTurn).not.toHaveBeenCalled()
  })

  for (const mode of ['grok', 'claude', 'codex'] as const) {
    it(`keeps the ${mode} process after a clean cancel`, async () => {
      host = createPeerHost()
      setAgentProcessHostForTests(host)
      const { chat, vault } = setup()
      vault.agentMode = mode
      chat.draft = 'hang'
      const pending = chat.send()
      await vi.waitUntil(() => host!.writes.some((chunk) => chunk.includes('hang')), { timeout: 5000 })
      if (mode === 'codex') await new Promise((resolve) => setTimeout(resolve, 100))
      chat.abort()
      await pending
      expect(chat.error).toBe('external-agent-stopped')
      expect(chat.running).toBe(false)
      expect(host.spawns).toHaveLength(1)
      expect(host.killCalls).toBe(0)
      expect(mockedTurn).not.toHaveBeenCalled()
      expect(chat.session.messages.filter((message) => message.role === 'assistant').every((message) => message.tools.length === 0)).toBe(true)
      const frames = writtenFrames(host.writes)
      if (mode === 'claude') {
        const interrupt = frames.find((frame) => frame.type === 'control_request' && (frame.request as { subtype?: string } | undefined)?.subtype === 'interrupt')
        expect(interrupt?.request).toEqual({ subtype: 'interrupt' })
        expect(interrupt?.request_id).toMatch(/^[0-9a-f]{32}$/)
        expect(JSON.stringify(interrupt)).not.toContain('cancel_queued')
      }
      if (mode === 'codex') {
        const interrupt = frames.find((frame) => frame.method === 'turn/interrupt')
        expect(interrupt?.params).toEqual({ threadId: 'thread-1', turnId: 'turn-0' })
        expect(frames.some((frame) => frame.method === 'thread/resume')).toBe(false)
      }
      if (mode === 'grok') {
        expect(frames).toContainEqual({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 'grok-session' } })
        const prompt = frames.find((frame) => frame.method === 'session/prompt')
        expect(frames).toContainEqual({
          jsonrpc: '2.0',
          method: '$/cancel_request',
          params: { requestId: prompt?.id },
        })
        expect(frames.some((frame) => frame.method === 'session/close' || frame.method === 'session/load')).toBe(false)
        const created = frames.find((frame) => frame.method === 'session/new')
        expect(created?.params).toEqual({
          cwd: '/vault',
          mcpServers: [],
          _meta: { rules: VAULT_CLI_RULES },
        })
        expect(created).not.toHaveProperty('_meta')
        expect(JSON.stringify(created)).not.toContain('yoloMode')
      }
      await send(chat, 'next')
      expect(chat.error).toBe('')
      expect(host.spawns).toHaveLength(1)
      expect(assistantText(chat)).toEqual(['', 'alpha'])
    })
  }

  for (const mode of ['grok', 'claude', 'codex'] as const) {
    it(`keeps the ${mode} session object after a cancel kills the process`, async () => {
      host = createPeerHost({ cancel: 'exit' })
      setAgentProcessHostForTests(host)
      const { chat, vault } = setup()
      vault.agentMode = mode
      chat.draft = 'hang'
      const pending = chat.send()
      await vi.waitUntil(() => host!.writes.some((chunk) => chunk.includes('hang')), { timeout: 5000 })
      if (mode === 'codex') await new Promise((resolve) => setTimeout(resolve, 100))
      chat.abort()
      await pending
      expect(chat.error).toBe('external-agent-stopped-resume')
      expect(host.spawns).toHaveLength(1)
      expect(host.killCalls).toBe(1)
      expect(mockedTurn).not.toHaveBeenCalled()
      expect(chat.session.external?.[mode]?.handle).toBe(mode === 'claude' ? 'claude-session' : mode === 'codex' ? 'thread-1' : 'grok-session')
      expect(chat.session.external?.[mode]?.cwd).toBe('/vault')
      await send(chat, 'next')
      if (mode === 'grok') {
        expect(chat.error).toBe('external-agent-resume-failed')
        const written = host.writes.join('\n')
        expect(written).not.toContain('session/load')
        expect(written).toContain('The previous CLI session could not be resumed.')
      } else {
        expect(chat.error).toBe('')
      }
      expect(host.spawns).toHaveLength(2)
      expect(assistantText(chat)).toEqual(['', 'alpha'])
      if (mode === 'claude') {
        expect(host.spawns[1]?.args).toEqual([...spawnArgs('claude'), '--resume', 'claude-session'])
      }
      if (mode === 'codex') {
        expect(writtenFrames(host.writes).some((frame) => frame.method === 'thread/resume')).toBe(true)
        expect(writtenFrames(host.writes).some((frame) => frame.method === 'session/load')).toBe(false)
      }
    })
  }

  for (const mode of ['grok', 'codex'] as const) {
    it(`kills ${mode} when the cancel method is missing and still does not drop the session`, async () => {
      host = createPeerHost({ cancel: 'missing' })
      setAgentProcessHostForTests(host)
      const { chat, vault } = setup()
      vault.agentMode = mode
      chat.draft = 'hang'
      const pending = chat.send()
      await vi.waitUntil(() => host!.writes.some((chunk) => chunk.includes('hang')), { timeout: 5000 })
      if (mode === 'codex') await new Promise((resolve) => setTimeout(resolve, 100))
      chat.abort()
      await pending
      expect(chat.error).toBe('external-agent-stopped-resume')
      expect(writtenFrames(host.writes).some((frame) => frame.method === 'turn/interrupt' || frame.method === 'session/cancel')).toBe(true)
      expect(host.killCalls).toBe(1)
      expect(mockedTurn).not.toHaveBeenCalled()
    })
  }

  async function collect(mode: 'grok' | 'claude' | 'codex') {
    host = createPeerHost()
    setAgentProcessHostForTests(host)
    const session = new ExternalAgentSession(host, mode, '/vault')
    const activity: ExternalActivity[] = []
    let textOut = ''
    try {
      await session.prompt('activity', AbortSignal.timeout(8000), (delta) => {
        textOut += delta
      }, (event) => {
        activity.push(event)
      })
    } finally {
      await session.stop()
    }
    return { activity, textOut, frames: writtenFrames(host.writes) }
  }

  it('records claude tool rows without partial stream_event arguments', async () => {
    const { activity, textOut } = await collect('claude')
    expect(textOut).toBe('alpha')
    expect(activity).toEqual([
      { id: 'req-1', name: 'Bash', phase: 'start', args: { command: 'true' }, result: '', isError: false },
      { id: 'req-1', name: 'Bash', phase: 'end', args: { command: 'true' }, result: 'allow', isError: false },
      { id: 'toolu_1', name: 'Read', phase: 'start', args: { path: 'notes/a.stride.json' }, result: '', isError: false },
      { id: 'toolu_2', name: 'Bash', phase: 'start', args: { command: 'false' }, result: '', isError: false },
      { id: 'toolu_1', name: 'Read', phase: 'end', args: {}, result: 'note body', isError: false },
      { id: 'toolu_2', name: 'Bash', phase: 'end', args: {}, result: 'nope', isError: true },
    ])
    expect(activity.some((event) => event.id === 'partial-tool')).toBe(false)
    expect(host?.spawns[0]?.args).toEqual(spawnArgs('claude'))
    expect(host?.writes.join('\n')).toContain('"behavior":"allow"')
  })

  it('records grok tool rows and ignores thought, plan, and fs_notify', async () => {
    const { activity, textOut, frames } = await collect('grok')
    expect(textOut).toBe('alpha')
    expect(textOut).not.toContain('secret-thought')
    expect(activity).toEqual([
      { id: 'call-1', name: 'Read file', phase: 'start', args: { path: 'a.stride.json' }, result: '', isError: false },
      { id: 'search-1', name: 'search', phase: 'start', args: {}, result: '', isError: false },
      {
        id: 'call-1',
        name: 'Read file',
        phase: 'end',
        args: {},
        result: '{"lines":2}\nboom',
        isError: true,
      },
    ])
    expect(JSON.stringify(activity)).not.toContain('fs_notify')
    expect(frames.some((frame) => frame.method === 'session/set_model' || frame.method === 'session/load')).toBe(false)
    expect(frames.find((frame) => frame.method === 'session/new')?.params).toEqual({
      cwd: '/vault',
      mcpServers: [],
      _meta: { rules: VAULT_CLI_RULES },
    })
    expect(host?.spawns[0]?.args).toEqual([...EXTERNAL_AGENT_SPAWN.grok.args])
  })

  it('accepts codex command, file, and elicitation requests and records tool rows', async () => {
    const { activity, textOut, frames } = await collect('codex')
    expect(textOut).toBe('alpha')
    expect(textOut).not.toContain('secret-thought')
    expect(textOut).not.toContain('TAILMARK')
    const reply = (id: number | string) => frames.find((frame) => frame.id === id && frame.method == null)
    expect(reply(9001)?.result).toEqual({ decision: 'accept' })
    expect(reply('file-approval')?.result).toEqual({ decision: 'accept' })
    expect(reply(9003)?.result).toEqual({ action: 'accept', content: {} })
    expect(reply(9005)?.result).toEqual({})
    expect(frames.some((frame) => frame.id === 9004)).toBe(false)
    const written = JSON.stringify(frames)
    expect(written).not.toContain('fileSystem')
    expect(written).not.toContain('network')
    expect(written).not.toContain('danger-full-access')
    expect(written).not.toContain('CODEX_HOME')
    expect(frames.find((frame) => frame.method === 'thread/start')?.params).toEqual({
      sandbox: 'workspace-write',
      approvalPolicy: 'on-request',
      developerInstructions: VAULT_CLI_RULES,
    })
    expect(frames.some((frame) => frame.method === 'thread/resume')).toBe(false)
    expect(host?.spawns[0]?.args).toEqual([...EXTERNAL_AGENT_SPAWN.codex.args])

    const brief = activity.map(({ id, name, phase, isError }) => ({ id, name, phase, isError }))
    expect(brief).toEqual([
      { id: '9004', name: 'permissions', phase: 'end', isError: true },
      { id: '9005', name: UNHANDLED_METHOD.slice(0, 60), phase: 'end', isError: false },
      { id: 'cmd-1', name: 'command', phase: 'start', isError: false },
      { id: 'cmd-1', name: 'command', phase: 'end', isError: false },
      { id: 'cmd-deny', name: 'command', phase: 'end', isError: true },
      { id: 'file-1', name: 'file', phase: 'end', isError: false },
      { id: 'file-2', name: 'file', phase: 'end', isError: false },
      { id: 'mcp-1', name: 'mcp:vault/search', phase: 'end', isError: false },
      { id: 'mcp-err', name: 'mcp:vault/broken', phase: 'end', isError: true },
      { id: 'web-1', name: 'web_search', phase: 'end', isError: false },
    ])
    const commandEnd = activity.find((event) => event.id === 'cmd-1' && event.phase === 'end')
    expect(commandEnd?.args).toEqual({ command: 'ls', cwd: '/vault' })
    expect(commandEnd?.result.startsWith('completed; exitCode=0;')).toBe(true)
    expect(commandEnd?.result.endsWith('TAILMARK')).toBe(true)
    expect(commandEnd?.result).not.toContain('HEAD')
    expect(activity.find((event) => event.id === 'cmd-deny')?.result).toBe('declined')
    expect(activity.find((event) => event.id === 'file-1')).toMatchObject({
      args: [
        { path: 'readme.md', kind: 'update' },
        { path: 'notes/a.stride.json', kind: 'add' },
      ],
      result: `completed; undo unavailable; ${'D'.repeat(200)}`,
    })
    expect(activity.find((event) => event.id === 'file-2')).toMatchObject({
      args: [{ path: 'notes/a.stride.json', kind: 'update' }],
      result: 'completed; hello-note',
    })
    expect(activity.find((event) => event.id === 'file-2')?.result).not.toContain('undo unavailable')
    expect(activity.find((event) => event.id === 'mcp-1')).toMatchObject({
      args: { q: 'moss' },
      result: '{"content":[{"text":"found"}]}',
    })
    expect(activity.find((event) => event.id === 'mcp-err')?.result).toBe('{"message":"nope"}')
    expect(activity.find((event) => event.id === 'web-1')).toMatchObject({
      args: 'stride notes',
      result: 'completed',
    })
    expect(activity.find((event) => event.id === '9004')).toEqual({
      id: '9004',
      name: 'permissions',
      phase: 'end',
      args: {},
      result: 'permissions request not auto-granted',
      isError: true,
    })
    expect(activity.find((event) => event.id === '9005')?.name).toHaveLength(60)
    expect(activity.some((event) => event.id === 'reason-1')).toBe(false)
  }, 15000)

  it('resumes claude with --resume after the rules and persists the returned id', async () => {
    host = createPeerHost()
    setAgentProcessHostForTests(host)
    const { chat, vault } = setup()
    vault.agentMode = 'claude'
    chat.session.external = { claude: { handle: 'sess_1.A:b', cwd: '/vault' } }
    await send(chat, 'hello')
    expect(chat.error).toBe('')
    expect(host.spawns[0]?.args).toEqual([...spawnArgs('claude'), '--resume', 'sess_1.A:b'])
    expect(promptTexts(host.writes)[0]).toBe('hello')
    expect(chat.session.external?.claude).toEqual({ handle: 'claude-session', cwd: '/vault' })
    const { store } = await resolveAppDataStore()
    const body = parseSession((await store.readText(`chats/${vaultStorageKey('vault-1')}/${chat.session.id}.json`)) ?? '')
    expect(body?.messages.some((message) => message.role === 'user' && message.text === 'hello')).toBe(true)
    expect(body?.external?.claude).toEqual({ handle: 'claude-session', cwd: '/vault' })
  })

  it('drops a claude handle that cannot be one argv element and still sends', async () => {
    host = createPeerHost()
    setAgentProcessHostForTests(host)
    const { chat, vault } = setup()
    vault.agentMode = 'claude'
    chat.session.external = { claude: { handle: 'bad id', cwd: '/vault' } }
    await send(chat, 'hello')
    expect(chat.error).toBe('external-agent-resume-failed')
    expect(host.spawns).toHaveLength(1)
    expect(host.spawns[0]?.args).toEqual(spawnArgs('claude'))
    expect(promptTexts(host.writes)[0]).toContain(RESUME_PREFACE_PREFIX)
    expect(chat.session.external?.claude).toEqual({ handle: 'claude-session', cwd: '/vault' })
    await send(chat, 'second')
    expect(promptTexts(host.writes).at(-1)).toBe('second')
    expect(chat.error).toBe('')
  })

  it('starts a fresh claude process when --resume exits', async () => {
    host = createPeerHost({ resume: 'exit' })
    setAgentProcessHostForTests(host)
    const { chat, vault } = setup()
    vault.agentMode = 'claude'
    chat.session.external = { claude: { handle: 'sess_dead', cwd: '/vault' } }
    await send(chat, 'hello')
    expect(chat.error).toBe('external-agent-resume-failed')
    expect(host.spawns).toHaveLength(2)
    expect(host.spawns[0]?.args).toContain('--resume')
    expect(host.spawns[1]?.args).toEqual(spawnArgs('claude'))
    expect(promptTexts(host.writes)[0]).toContain(RESUME_PREFACE_PREFIX)
    expect(assistantText(chat)).toEqual(['alpha'])
    expect(chat.session.external?.claude?.handle).toBe('claude-session')
  })

  it('resumes codex with thread/resume and does not send a model', async () => {
    host = createPeerHost()
    setAgentProcessHostForTests(host)
    const { chat, vault } = setup()
    vault.agentMode = 'codex'
    chat.session.external = { codex: { handle: 'thread-9', cwd: '/vault' } }
    await send(chat, 'hello')
    expect(chat.error).toBe('')
    const frames = writtenFrames(host.writes)
    const resumed = frames.find((frame) => frame.method === 'thread/resume')
    expect(resumed?.params).toEqual({
      threadId: 'thread-9',
      cwd: '/vault',
      sandbox: 'workspace-write',
      approvalPolicy: 'on-request',
      developerInstructions: VAULT_CLI_RULES,
    })
    expect(frames.some((frame) => frame.method === 'thread/start')).toBe(false)
    expect(JSON.stringify(resumed)).not.toMatch(/"model"/)
    expect(host.spawns[0]?.args).toEqual([...EXTERNAL_AGENT_SPAWN.codex.args])
    expect(promptTexts(host.writes)[0]).toBe('hello')
    expect(chat.session.external?.codex).toEqual({ handle: 'thread-9', cwd: '/vault' })
  })

  it('starts a fresh codex thread when thread/resume fails and keeps sending', async () => {
    host = createPeerHost({ resume: 'fail' })
    setAgentProcessHostForTests(host)
    const { chat, vault } = setup()
    vault.agentMode = 'codex'
    chat.session.external = { codex: { handle: 'missing-thread', cwd: '/vault' } }
    await send(chat, 'hello')
    expect(chat.error).toBe('external-agent-resume-failed')
    expect(assistantText(chat)).toEqual(['alpha'])
    expect(host.spawns).toHaveLength(2)
    const frames = writtenFrames(host.writes)
    expect(frames.some((frame) => frame.method === 'thread/resume')).toBe(true)
    expect(frames.some((frame) => frame.method === 'thread/start')).toBe(true)
    expect(promptTexts(host.writes)[0]).toContain(RESUME_PREFACE_PREFIX)
    expect(chat.session.external?.codex).toEqual({ handle: 'thread-1', cwd: '/vault' })
    await send(chat, 'second')
    expect(promptTexts(host.writes).at(-1)).toBe('second')
    expect(chat.error).toBe('')
    expect(host.spawns).toHaveLength(2)
  })

  it('starts a fresh codex thread when the resume process exits', async () => {
    host = createPeerHost({ resume: 'exit' })
    setAgentProcessHostForTests(host)
    const { chat, vault } = setup()
    vault.agentMode = 'codex'
    chat.session.external = { codex: { handle: 'thread-gone', cwd: '/vault' } }
    await send(chat, 'hello')
    expect(chat.error).toBe('external-agent-resume-failed')
    expect(host.spawns).toHaveLength(2)
    expect(assistantText(chat)).toEqual(['alpha'])
    expect(writtenFrames(host.writes).some((frame) => frame.method === 'thread/start')).toBe(true)
    expect(chat.session.external?.codex?.handle).toBe('thread-1')
  })

  it('does not resume when the slot cwd differs and keeps that slot', async () => {
    host = createPeerHost()
    setAgentProcessHostForTests(host)
    const { chat, vault } = setup()
    vault.agentMode = 'codex'
    chat.session.external = { codex: { handle: 'thread/old+id=', cwd: '/other' } }
    await send(chat, 'hello')
    expect(chat.error).toBe('')
    const frames = writtenFrames(host.writes)
    expect(frames.some((frame) => frame.method === 'thread/resume')).toBe(false)
    expect(frames.some((frame) => frame.method === 'thread/start')).toBe(true)
    expect(promptTexts(host.writes)[0]).toContain(RESUME_PREFACE_PREFIX)
    expect(chat.session.external?.codex).toEqual({ handle: 'thread/old+id=', cwd: '/other' })
    await send(chat, 'second')
    expect(promptTexts(host.writes).at(-1)).toBe('second')
    expect(chat.session.external?.codex).toEqual({ handle: 'thread/old+id=', cwd: '/other' })
  })

  it('does not call session/load for a stored grok handle and prefaces only the fresh process', async () => {
    host = createPeerHost()
    setAgentProcessHostForTests(host)
    const { chat, vault, settings } = setup()
    settings.form = {
      ...settings.form,
      llmConfigs: [{ id: 'cfg', name: 'P', provider: 'openai', model: 'm', baseUrl: 'https://example.test/v1', keyMask: '••••', isDefault: true }],
    }
    Object.assign(settings, { memoryLlmKeys: { cfg: 'sk-abc-xyz' } })
    vault.agentMode = 'grok'
    chat.session.messages = [
      { role: 'user', text: 'leak sk-abc-xyz please', thinking: '', tools: [] },
      {
        role: 'assistant',
        text: 'noted',
        thinking: '',
        tools: [{ id: 't', name: 'read_note', argsSummary: 'x', resultSummary: 'SECRET-RESULT', durationMs: 1, isError: false, pending: false }],
      },
    ]
    chat.session.external = {
      grok: { handle: 'old/id+=', cwd: '/vault' },
      claude: { handle: 'sess_keep', cwd: '/vault' },
    }
    await send(chat, 'hello')
    expect(chat.error).toBe('external-agent-resume-failed')
    const frames = writtenFrames(host.writes)
    expect(frames.some((frame) => frame.method === 'session/load' || frame.method === 'session/set_model')).toBe(false)
    const first = promptTexts(host.writes)[0] ?? ''
    expect(first.startsWith(RESUME_PREFACE_PREFIX)).toBe(true)
    expect(first).toContain('tools: read_note')
    expect(first).not.toContain('SECRET-RESULT')
    expect(first).not.toContain('sk-abc-xyz')
    expect(first).toContain('••••')
    expect(first.endsWith('hello')).toBe(true)
    expect(chat.session.external?.grok).toEqual({ handle: 'grok-session', cwd: '/vault' })
    expect(chat.session.external?.claude).toEqual({ handle: 'sess_keep', cwd: '/vault' })
    await send(chat, 'again')
    expect(promptTexts(host.writes).at(-1)).toBe('again')
    expect(chat.error).toBe('')
    expect(host.spawns).toHaveLength(1)
  })

  it('keeps a grok slot when the cwd does not match and does not set resume-failed', async () => {
    host = createPeerHost()
    setAgentProcessHostForTests(host)
    const { chat, vault } = setup()
    vault.agentMode = 'grok'
    chat.session.external = { grok: { handle: 'old/id+=', cwd: '/other' } }
    await send(chat, 'hello')
    expect(chat.error).toBe('')
    expect(writtenFrames(host.writes).some((frame) => frame.method === 'session/load')).toBe(false)
    expect(promptTexts(host.writes)[0]).toContain(RESUME_PREFACE_PREFIX)
    expect(chat.session.external?.grok).toEqual({ handle: 'old/id+=', cwd: '/other' })
  })

  it('keeps the other mode slot when the user changes agent mode', async () => {
    host = createPeerHost()
    setAgentProcessHostForTests(host)
    const { chat, vault } = setup()
    vault.agentMode = 'claude'
    await send(chat, 'first')
    expect(chat.session.external?.claude).toEqual({ handle: 'claude-session', cwd: '/vault' })
    await vault.setAgentMode('codex')
    expect(chat.session.external?.claude).toEqual({ handle: 'claude-session', cwd: '/vault' })
    await send(chat, 'next')
    expect(host.spawns.map((spec) => spec.command)).toEqual(['claude', 'codex'])
    expect(writtenFrames(host.writes).some((frame) => frame.method === 'thread/resume')).toBe(false)
    await vault.setAgentMode('claude')
    await send(chat, 'back')
    expect(host.spawns[2]?.args).toEqual([...spawnArgs('claude'), '--resume', 'claude-session'])
    expect(chat.error).toBe('')
  })

  it('prefaces once when the stored slot was dropped at parse time', async () => {
    host = createPeerHost()
    setAgentProcessHostForTests(host)
    const { chat, vault } = setup()
    vault.agentMode = 'codex'
    chat.session.externalDropped = ['codex']
    await send(chat, 'hello')
    expect(chat.error).toBe('external-agent-resume-failed')
    expect(writtenFrames(host.writes).some((frame) => frame.method === 'thread/resume')).toBe(false)
    expect(promptTexts(host.writes)[0]).toContain(RESUME_PREFACE_PREFIX)
    expect(chat.session.externalDropped).toBeUndefined()
    expect(chat.session.external?.codex?.handle).toBe('thread-1')
    await send(chat, 'second')
    expect(promptTexts(host.writes).at(-1)).toBe('second')
    expect(chat.error).toBe('')
  })

  it('writes claude tool rows from the send path', async () => {
    host = createPeerHost()
    setAgentProcessHostForTests(host)
    const { chat, vault } = setup()
    vault.agentMode = 'claude'
    await send(chat, 'activity')
    const tools = chat.session.messages.at(-1)?.tools ?? []
    expect(tools.map((tool) => tool.name)).toEqual(['Bash', 'Read', 'Bash'])
    expect(tools.find((tool) => tool.id === 'toolu_1')).toMatchObject({ pending: false, resultSummary: 'note body', isError: false })
    expect(tools.find((tool) => tool.id === 'toolu_2')?.isError).toBe(true)
  })
})
