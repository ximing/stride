import { has, observer, register, resolve, useService } from '@rabjs/react'
import { MemoryFileSystem, MemorySecretsStore, type GitBackend } from '@stride/platform'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { App, UpdateBanner } from '../app'
import { DEDICATED_ERROR, VAULT_GITIGNORE } from '@stride/core'
import { createNote, serializeNote } from '@stride/core/note'
import { GitService, resetSecretsStore, setCloneDestForTests, setCloneParentForTests, setCommitMessageSuggestForTests, setGitBackendForTests, setSecretsStore, SETTINGS_STORAGE_KEY, SettingsService, UpdateService } from './panels.service'
import { VaultService } from './vault.service'

function resetSettingsMemory() {
  const settings = resolve(SettingsService)
  settings.form = {
    embedding: { endpoint: '', model: '', keyMask: '', dim: 4 },
    llmConfigs: [],
    releasesUrl: '',
    gitEnabled: true,
    autoSyncMinutes: 0,
    autoGitEnabled: false,
    autoGitIdleSeconds: 0,
    autoGitBlurSeconds: 0,
  }
  settings.setEmbeddingDim('4')
  settings.embeddingKey = ''
  settings.llmKeyDrafts = {}
  settings.selectedLlmId = ''
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

describe('browser panels', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    localStorage.removeItem(SETTINGS_STORAGE_KEY)
    if (has(SettingsService)) resetSettingsMemory()
    resetSecretsStore()
    setGitBackendForTests(null)
    setCloneParentForTests(null)
    setCloneDestForTests(null)
    setCommitMessageSuggestForTests(null)
    if (has(GitService)) {
      const git = resolve(GitService)
      git.stopAutoSync()
      git.stopAutoGit()
      git.lastActivityAt = 0
      git.lastBlurAt = 0
      Object.assign(git, { idleCheckpointAt: 0, blurCheckpointAt: 0 })
      git.abortSuggest()
      git.cloneUrl = ''
      git.cloneError = ''
      git.output = 'Git is not available in the browser'
      git.surface = 'unavailable'
      git.notice = ''
      git.branch = ''
      git.isRepo = false
      git.hasVault = false
      git.changes = []
      git.selected = []
      git.ahead = 0
      git.behind = 0
      git.suggesting = false
      git.busy = false
      git.diff = ''
      git.message = ''
      git.conflicts = []
    }
  })

  it('boots without calling the API and keeps updates idle', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    register(VaultService)
    register(SettingsService)
    register(UpdateService)
    register(GitService)
    await resolve(SettingsService).load()
    await resolve(SettingsService).save()
    const updates = resolve(UpdateService)
    await updates.check()
    await updates.download()
    await updates.confirm()
    await updates.dismiss()
    const git = resolve(GitService)
    expect(git.output).toBe('Git is not available in the browser')
    await git.refresh()
    await git.init()
    await git.commit()
    await git.pull()
    await git.push()
    await git.keepSide('note', 'ours')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(updates.phase).toBe('idle')
    expect(updates.error).toBe('')
    expect(git.output).toBe('Git is not available in the browser')
    expect(resolve(SettingsService).form.embedding.endpoint).toBe('')
    expect(resolve(SettingsService).notice).toBe('')
  })

  it('does not write the plaintext embedding key to localStorage', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const secrets = new MemorySecretsStore()
    setSecretsStore(secrets)
    register(SettingsService)
    const settings = resolve(SettingsService)
    const key = 'sk-stride-embed-test-key'
    settings.patchEmbedding({ endpoint: 'http://127.0.0.1/v1', model: 'fixture-embed' })
    settings.setEmbeddingDim('4')
    settings.embeddingKey = key
    await settings.save()
    const stored = localStorage.getItem(SETTINGS_STORAGE_KEY) ?? ''
    expect(stored.includes(key)).toBe(false)
    expect(stored.includes('keySeal')).toBe(true)
    expect(stored.includes('"apiKey"')).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(settings.embeddingKey).toBe('')
    expect(settings.form.embedding.keyMask).toBe('••••-key')
    expect(settings.notice).toBe('')

    settings.embeddingKey = 'plaintext-should-not-remain'
    await settings.load()
    expect(settings.embeddingKey).toBe('')
    expect(settings.embeddingRuntime().apiKey).toBe(key)
    expect(settings.form.embedding.keyMask).toBe('••••-key')
    expect(settings.embeddingRuntime().active).toBe(true)

    settings.embeddingKey = settings.form.embedding.keyMask
    settings.patchEmbedding({ model: 'fixture-embed-2' })
    await settings.save()
    expect((localStorage.getItem(SETTINGS_STORAGE_KEY) ?? '').includes(key)).toBe(false)
    expect(settings.embeddingRuntime().apiKey).toBe(key)
    expect(settings.embeddingRuntime().model).toBe('fixture-embed-2')

    settings.embeddingKey = ''
    await settings.save()
    expect(settings.embeddingRuntime().apiKey).toBe('')
    expect(settings.embeddingRuntime().intended).toBe(true)
    expect(settings.embeddingRuntime().active).toBe(false)
    expect((localStorage.getItem(SETTINGS_STORAGE_KEY) ?? '').includes(key)).toBe(false)

    settings.setEmbeddingDim('nope')
    await settings.save()
    await settings.load()
    expect(settings.embeddingDimText).toBe('')
    expect(settings.embeddingRuntime().dim).toBe(0)
    expect(settings.embeddingRuntime().intended).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reports the embedding probe without writing settings', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      data: [{ index: 0, embedding: [1, 0, 0, 0] }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    register(SettingsService)
    const settings = resolve(SettingsService)
    settings.patchEmbedding({ endpoint: 'http://127.0.0.1/v1', model: 'fixture-embed' })
    settings.setEmbeddingDim('4')
    settings.embeddingKey = 'sk-stride-embed-test-key'
    await settings.testEmbedding()
    expect(settings.embeddingTestResult).toBe('连接成功')
    expect(localStorage.getItem(SETTINGS_STORAGE_KEY)).toBeNull()
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit
    expect(JSON.parse(String(init.body)).input).toEqual(['连接测试'])

    fetchMock.mockResolvedValueOnce(new Response('no', { status: 401 }))
    await settings.testEmbedding()
    expect(settings.embeddingTestResult).toContain('401')

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    await settings.testEmbedding()
    expect(settings.embeddingTestResult).toContain('expected 1')

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      data: [{ index: 0, embedding: [1, 0] }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    await settings.testEmbedding()
    expect(settings.embeddingTestResult).toContain('维度不符')

    const calls = fetchMock.mock.calls.length
    settings.setEmbeddingDim('')
    await settings.testEmbedding()
    expect(settings.embeddingTestResult).toBe('维度不符')
    expect(fetchMock.mock.calls.length).toBe(calls)
  })

  it('saves two llm configs, switches the default, and refuses a plaintext key', async () => {
    const secrets = new MemorySecretsStore()
    setSecretsStore(secrets)
    register(SettingsService)
    const settings = resolve(SettingsService)
    settings.addLlmConfig()
    const first = settings.selectedLlmId
    settings.patchLlmConfig({ name: 'Primary' })
    settings.llmKeyDrafts = { [first]: 'sk-stride-llm-alpha-key' }
    settings.addLlmConfig()
    const second = settings.selectedLlmId
    expect(second).not.toBe(first)
    expect(settings.form.llmConfigs[0]?.isDefault).toBe(true)
    expect(settings.form.llmConfigs[1]?.isDefault).toBe(false)
    settings.patchLlmConfig({ name: 'Backup', provider: 'deepseek' })
    expect(settings.form.llmConfigs.find((config) => config.id === second)?.model).toBe('deepseek-chat')
    settings.llmKeyDrafts = { ...settings.llmKeyDrafts, [second]: 'sk-stride-llm-beta-key' }
    await settings.save()
    const stored = localStorage.getItem(SETTINGS_STORAGE_KEY) ?? ''
    expect(stored.includes('sk-stride-llm-alpha-key')).toBe(false)
    expect(stored.includes('sk-stride-llm-beta-key')).toBe(false)
    expect(stored.includes('"apiKey"')).toBe(false)
    expect(settings.notice).toBe('')
    expect(settings.llmKeyDrafts).toEqual({})
    await settings.load()
    expect(settings.form.llmConfigs).toHaveLength(2)
    expect(settings.llmRuntime()?.apiKey).toBe('sk-stride-llm-alpha-key')
    expect(settings.llmRuntime()?.provider).toBe('openai')

    settings.selectedLlmId = second
    settings.setDefaultLlmConfig()
    expect(settings.form.llmConfigs.find((config) => config.id === second)?.isDefault).toBe(true)
    expect(settings.form.llmConfigs.find((config) => config.id === first)?.isDefault).toBe(false)
    const masks = Object.fromEntries(settings.form.llmConfigs.map((config) => [config.id, config.keyMask]))
    settings.llmKeyDrafts = masks
    await settings.save()
    await settings.load()
    expect(settings.llmRuntime()?.provider).toBe('deepseek')
    expect(settings.llmRuntime()?.apiKey).toBe('sk-stride-llm-beta-key')
    expect(settings.llmRuntime()?.model).toBe('deepseek-chat')

    setSecretsStore({
      seal: async (value) => value,
      open: async (value) => value,
    })
    settings.selectedLlmId = first
    settings.llmKeyDrafts = { [first]: 'sk-plaintext-should-not-land' }
    await settings.save()
    expect(settings.notice).toContain('plaintext')
    expect(localStorage.getItem(SETTINGS_STORAGE_KEY) ?? '').not.toContain('sk-plaintext-should-not-land')
  })

  it('reports a successful llm probe from the selected config', async () => {
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
    register(SettingsService)
    const settings = resolve(SettingsService)
    settings.addLlmConfig()
    settings.llmKeyDrafts = { [settings.selectedLlmId]: 'sk-stride-llm-test-key' }
    await settings.testSelectedLlm()
    expect(settings.llmTestResult).toBe('连接成功')
    expect(fetchMock).toHaveBeenCalled()
  })

  it('hides the update banner while idle', async () => {
    register(UpdateService)
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const View = observer(function View() {
      useService(UpdateService)
      return <UpdateBanner />
    })
    await act(async () => {
      root.render(<View />)
    })
    expect(host.querySelector('[data-testid="update-banner"]')).toBeNull()
    root.unmount()
    host.remove()
  })

  it('initializes a non-repo vault when a git backend is available', async () => {
    const calls: string[] = []
    setGitBackendForTests(recordingGit(calls))
    register(VaultService)
    register(SettingsService)
    register(GitService)
    const files = new MemoryFileSystem('/tmp/vault')
    const vault = resolve(VaultService)
    vault.fs = files
    vault.broad = false
    resolve(SettingsService).setGitEnabled(true)
    const git = resolve(GitService)
    await git.refresh()
    expect(git.surface).toBe('needs-init')
    await git.init()
    expect(calls).toEqual(['init /tmp/vault', 'commit Initial commit'])
    expect(await files.readText('.gitignore')).toBe(VAULT_GITIGNORE)
  })

  it('refuses to initialize a broad Desktop root', async () => {
    const calls: string[] = []
    setGitBackendForTests(recordingGit(calls))
    register(VaultService)
    register(SettingsService)
    register(GitService)
    const files = new MemoryFileSystem('/tmp/Desktop')
    const vault = resolve(VaultService)
    vault.fs = files
    vault.broad = true
    const git = resolve(GitService)
    await git.init()
    expect(calls).toEqual([])
    expect(git.output).toBe(DEDICATED_ERROR)
    expect(git.surface).toBe('blocked')
    expect(await files.stat('.git')).toBeNull()
  })

  it('does not call git when the setting is off', async () => {
    const calls: string[] = []
    setGitBackendForTests(recordingGit(calls))
    register(VaultService)
    register(SettingsService)
    register(GitService)
    const files = new MemoryFileSystem('/tmp/vault-off')
    const vault = resolve(VaultService)
    vault.fs = files
    vault.broad = false
    resolve(SettingsService).setGitEnabled(false)
    const git = resolve(GitService)
    await git.init()
    await files.mkdir('.git')
    await git.refresh()
    expect(calls).toEqual([])
    expect(git.output).toBe('Git is turned off.')
    expect(git.notice).toBe('Git is turned off.')
    expect(git.surface).toBe('disabled')
  })

  it('commits only the selected path and records ahead', async () => {
    const commits: Array<{ message: string; paths?: string[] }> = []
    const repo = { porcelain: ' M a.md\n?? b.md\n' }
    setGitBackendForTests(twoFileGit(repo, commits))
    register(VaultService)
    register(SettingsService)
    register(GitService)
    const files = new MemoryFileSystem('/tmp/vault-commit')
    await files.mkdir('.git')
    const vault = resolve(VaultService)
    vault.fs = files
    vault.broad = false
    resolve(SettingsService).setGitEnabled(true)
    const git = resolve(GitService)
    await git.refresh()
    expect(git.surface).toBe('ready')
    expect(git.changes.map((change) => change.path)).toEqual(['a.md', 'b.md'])
    expect(git.selected).toEqual(['a.md', 'b.md'])
    expect(git.ahead).toBe(1)
    await git.openDiff('a.md')
    expect(git.diff).toBe('diff a.md\n')
    repo.porcelain = '?? b.md\n'
    await git.refresh()
    expect(git.diff).toBe('')
    expect(git.selected).toEqual(['b.md'])
    expect(git.message).toBe('')
    repo.porcelain = ' M a.md\n?? b.md\n'
    await git.refresh()
    git.toggle('b.md')
    git.setMessage('Save a')
    await git.commitSelected()
    expect(commits).toEqual([{ message: 'Save a', paths: ['a.md'] }])
    expect(git.ahead).toBe(1)
    expect(git.message).toBe('Save a')
    expect(git.branch).toBe('main')
  })

  it('suggests a message from the selected diffs and aborts the previous request', async () => {
    const commits: Array<{ message: string; paths?: string[] }> = []
    const repo = { porcelain: ' M a.md\n?? b.md\n' }
    const seen: string[] = []
    let first: AbortSignal | null = null
    setGitBackendForTests(twoFileGit(repo, commits))
    setCommitMessageSuggestForTests((diff, signal) => {
      seen.push(diff)
      if (!first) {
        first = signal
        return new Promise((resolvePromise) => {
          if (signal.aborted) {
            resolvePromise({ message: 'first', aborted: true })
            return
          }
          signal.addEventListener('abort', () => resolvePromise({ message: 'first', aborted: true }), { once: true })
        })
      }
      return Promise.resolve({ message: 'Update a', aborted: false })
    })
    register(VaultService)
    register(SettingsService)
    register(GitService)
    const files = new MemoryFileSystem('/tmp/vault-suggest')
    await files.mkdir('.git')
    const vault = resolve(VaultService)
    vault.fs = files
    vault.broad = false
    resolve(SettingsService).setGitEnabled(true)
    const git = resolve(GitService)
    await git.refresh()
    git.toggle('b.md')
    const pending = git.suggestMessage()
    await vi.waitFor(() => expect(first).not.toBeNull())
    const next = git.suggestMessage()
    await pending
    await next
    expect(git.message).toBe('Update a')
    expect(seen).toEqual(['diff a.md\n', 'diff a.md\n'])
    expect(seen.some((diff) => diff.includes('b.md'))).toBe(false)
    expect(git.suggesting).toBe(false)
    expect(commits).toEqual([])
  })

  it('asks for a model key instead of calling the network', async () => {
    const commits: Array<{ message: string; paths?: string[] }> = []
    const repo = { porcelain: ' M a.md\n' }
    setCommitMessageSuggestForTests(null)
    setGitBackendForTests(twoFileGit(repo, commits))
    register(VaultService)
    register(SettingsService)
    register(GitService)
    const files = new MemoryFileSystem('/tmp/vault-nokey')
    await files.mkdir('.git')
    const vault = resolve(VaultService)
    vault.fs = files
    vault.broad = false
    const settings = resolve(SettingsService)
    settings.form = { ...settings.form, llmConfigs: [], gitEnabled: true }
    const git = resolve(GitService)
    await git.refresh()
    git.setMessage('draft')
    await git.suggestMessage()
    expect(git.notice).toBe('Add a model provider, base URL, model, and key in Settings')
    expect(git.message).toBe('draft')
    expect(git.suggesting).toBe(false)
  })

  it('does not auto-sync when the interval is off or the tree is dirty', async () => {
    const pulls: string[] = []
    const backend = recordingGit([])
    backend.pull = () => {
      pulls.push('pull')
      return Promise.resolve({ conflict: false, files: [], output: 'Fast-forward' })
    }
    setGitBackendForTests(backend)
    register(VaultService)
    register(SettingsService)
    register(GitService)
    const files = new MemoryFileSystem('/tmp/vault-autosync-off')
    await files.mkdir('.git')
    const vault = resolve(VaultService)
    vault.fs = files
    vault.phase = 'ready'
    vault.broad = false
    const settings = resolve(SettingsService)
    settings.setGitEnabled(true)
    settings.setAutoSyncMinutes(0)
    const git = resolve(GitService)
    git.surface = 'ready'
    await git.autoSyncTick()
    expect(pulls).toEqual([])
    settings.setAutoSyncMinutes(1)
    backend.status = () => Promise.resolve({ repo: true, porcelain: ' M a.md\n', clean: false })
    await git.autoSyncTick()
    expect(pulls).toEqual([])
    expect(git.output).toBe('Commit local changes before pulling')
  })

  it('reloads after a fast-forward and skips reload when already up to date or in conflict', async () => {
    const pulls: string[] = []
    let output = 'Fast-forward\n notes/a.stride.json'
    let conflict = false
    let conflicted = false
    const backend = recordingGit([])
    backend.pull = () => {
      pulls.push('pull')
      if (conflict) conflicted = true
      return Promise.resolve({
        conflict,
        files: conflict ? ['notes/a.stride.json'] : [],
        output,
      })
    }
    // Pull refuses a dirty tree. The UU line appears only after that pull returns.
    backend.status = () => Promise.resolve({
      repo: true,
      porcelain: conflicted ? 'UU notes/a.stride.json\n' : '',
      clean: !conflicted,
    })
    setGitBackendForTests(backend)
    register(VaultService)
    register(SettingsService)
    register(GitService)
    const files = new MemoryFileSystem('/tmp/vault-autosync-ff')
    await files.mkdir('.git')
    const vault = resolve(VaultService)
    vault.fs = files
    vault.phase = 'ready'
    vault.broad = false
    let reopened = 0
    vault.reopenForSettings = () => {
      reopened += 1
      return Promise.resolve()
    }
    resolve(SettingsService).setGitEnabled(true)
    resolve(SettingsService).setAutoSyncMinutes(1)
    const git = resolve(GitService)
    git.surface = 'ready'
    await git.autoSyncTick()
    expect(pulls).toEqual(['pull'])
    expect(reopened).toBe(1)
    output = 'Already up to date.'
    await git.autoSyncTick()
    expect(pulls).toEqual(['pull', 'pull'])
    expect(reopened).toBe(1)
    output = 'CONFLICT (content): Merge conflict in notes/a.stride.json'
    conflict = true
    await git.autoSyncTick()
    expect(reopened).toBe(1)
    expect(git.conflicts).toEqual(['notes/a.stride.json'])
  })

  it('does not checkpoint when auto git is off', async () => {
    const commits: Array<{ message: string; paths?: string[] }> = []
    const repo = { porcelain: ' M notes/a.stride.json\n' }
    setGitBackendForTests(twoFileGit(repo, commits))
    register(VaultService)
    register(SettingsService)
    register(GitService)
    const files = new MemoryFileSystem('/tmp/vault-autogit-off')
    await files.mkdir('.git')
    const vault = resolve(VaultService)
    vault.fs = files
    vault.phase = 'ready'
    vault.broad = false
    const settings = resolve(SettingsService)
    settings.setGitEnabled(true)
    settings.setAutoGitEnabled(false)
    settings.setAutoGitIdleSeconds(60)
    const git = resolve(GitService)
    git.surface = 'ready'
    git.noteActivity()
    await git.autoGitTick(Date.now() + 120_000)
    expect(commits).toEqual([])
  })

  it('checkpoints the full tree once when idle is due', async () => {
    const commits: Array<{ message: string; paths?: string[] }> = []
    const repo = { porcelain: ' M notes/a.stride.json\n' }
    setGitBackendForTests(twoFileGit(repo, commits))
    register(VaultService)
    register(SettingsService)
    register(GitService)
    const files = new MemoryFileSystem('/tmp/vault-autogit-idle')
    await files.mkdir('.git')
    const vault = resolve(VaultService)
    vault.fs = files
    vault.phase = 'ready'
    vault.broad = false
    const settings = resolve(SettingsService)
    settings.setGitEnabled(true)
    settings.setAutoGitEnabled(true)
    settings.setAutoGitIdleSeconds(60)
    settings.setAutoGitBlurSeconds(0)
    const git = resolve(GitService)
    git.surface = 'ready'
    git.lastActivityAt = 1_000
    await git.autoGitTick(61_000)
    expect(commits).toEqual([{ message: 'Checkpoint', paths: undefined }])
    await git.autoGitTick(61_000)
    expect(commits).toEqual([{ message: 'Checkpoint', paths: undefined }])
  })

  it('does not checkpoint while files are unmerged', async () => {
    const commits: Array<{ message: string; paths?: string[] }> = []
    const repo = { porcelain: 'UU notes/a.stride.json\n' }
    const backend = twoFileGit(repo, commits)
    backend.unmerged = () => Promise.resolve(['notes/a.stride.json'])
    setGitBackendForTests(backend)
    register(VaultService)
    register(SettingsService)
    register(GitService)
    const files = new MemoryFileSystem('/tmp/vault-autogit-unmerged')
    await files.mkdir('.git')
    const vault = resolve(VaultService)
    vault.fs = files
    vault.phase = 'ready'
    vault.broad = false
    const settings = resolve(SettingsService)
    settings.setGitEnabled(true)
    settings.setAutoGitEnabled(true)
    settings.setAutoGitIdleSeconds(60)
    settings.setAutoGitBlurSeconds(0)
    const git = resolve(GitService)
    git.surface = 'ready'
    git.lastActivityAt = 1_000
    await git.autoGitTick(61_000)
    expect(commits).toEqual([])
  })

  it('does not checkpoint on blur when the blur threshold is 0', async () => {
    const commits: Array<{ message: string; paths?: string[] }> = []
    const repo = { porcelain: ' M notes/a.stride.json\n' }
    setGitBackendForTests(twoFileGit(repo, commits))
    register(VaultService)
    register(SettingsService)
    register(GitService)
    const files = new MemoryFileSystem('/tmp/vault-autogit-blur')
    await files.mkdir('.git')
    const vault = resolve(VaultService)
    vault.fs = files
    vault.phase = 'ready'
    vault.broad = false
    const settings = resolve(SettingsService)
    settings.setGitEnabled(true)
    settings.setAutoGitEnabled(true)
    settings.setAutoGitIdleSeconds(0)
    settings.setAutoGitBlurSeconds(0)
    const git = resolve(GitService)
    git.surface = 'ready'
    git.noteBlur()
    await git.autoGitTick(Date.now() + 120_000)
    expect(commits).toEqual([])
  })

  it('does not pull a dirty vault', async () => {
    const commits: Array<{ message: string; paths?: string[] }> = []
    const pulls: string[] = []
    const repo = { porcelain: ' M a.md\n' }
    const backend = twoFileGit(repo, commits)
    backend.pull = () => {
      pulls.push('pull')
      return Promise.resolve({ conflict: false, files: [], output: '' })
    }
    setGitBackendForTests(backend)
    register(VaultService)
    register(SettingsService)
    register(GitService)
    const files = new MemoryFileSystem('/tmp/vault-dirty-pull')
    await files.mkdir('.git')
    const vault = resolve(VaultService)
    vault.fs = files
    vault.broad = false
    resolve(SettingsService).setGitEnabled(true)
    const git = resolve(GitService)
    await git.pull()
    expect(pulls).toEqual([])
    expect(commits).toEqual([])
    expect(git.output).toBe('Commit local changes before pulling')
  })

  it('shows an in-progress merge as conflicts on refresh', async () => {
    const backend = recordingGit([])
    backend.status = () => Promise.resolve({
      repo: true,
      porcelain: 'UU untitled-nbz2.stride.json\n',
      clean: false,
    })
    setGitBackendForTests(backend)
    register(VaultService)
    register(SettingsService)
    register(GitService)
    const files = new MemoryFileSystem('/tmp/vault-refresh-conflict')
    await files.mkdir('.git')
    const vault = resolve(VaultService)
    vault.fs = files
    vault.broad = false
    vault.phase = 'chooser'
    resolve(SettingsService).setGitEnabled(true)
    const git = resolve(GitService)
    await git.refresh()
    expect(git.conflicts).toEqual(['untitled-nbz2.stride.json'])
    expect(git.behind).toBe(0)
  })

  it('records pull conflicts and clears them after a clean pull', async () => {
    let treeClean = true
    let conflictPull = true
    const backend = recordingGit([])
    backend.status = () => Promise.resolve({
      repo: true,
      porcelain: treeClean ? '' : 'UU notes/a.md\nUU notes/b.md\n',
      clean: treeClean,
    })
    backend.pull = () => {
      if (conflictPull) {
        conflictPull = false
        treeClean = false
        return Promise.resolve({
          conflict: true,
          files: ['notes/a.md', 'notes/b.md'],
          output: 'CONFLICT (content): Merge conflict in notes/a.md',
        })
      }
      treeClean = true
      return Promise.resolve({ conflict: false, files: [], output: '' })
    }
    setGitBackendForTests(backend)
    register(VaultService)
    register(SettingsService)
    register(GitService)
    const files = new MemoryFileSystem('/tmp/vault-conflict-pull')
    await files.mkdir('.git')
    const vault = resolve(VaultService)
    vault.fs = files
    vault.broad = false
    vault.phase = 'chooser'
    resolve(SettingsService).setGitEnabled(true)
    const git = resolve(GitService)
    await git.pull()
    expect(git.conflicts).toEqual(['notes/a.md', 'notes/b.md'])
    expect(git.output).toBe('CONFLICT (content): Merge conflict in notes/a.md')
    treeClean = true
    await git.pull()
    expect(git.conflicts).toEqual([])
    expect(git.output).toBe('')
  })

  it('checkpoints the conflicted text before resolve and refuses a .. path', async () => {
    const marker = '<<<<<<< ours\nlocal\n=======\nremote\n>>>>>>> theirs\n'
    const events: string[] = []
    let pending = ['notes/a.md']
    let sawCheckpoint = false
    const files = new MemoryFileSystem('/tmp/vault-keep-side')
    await files.mkdir('.git')
    await files.writeText('notes/a.md', marker)
    const backend = recordingGit(events)
    backend.status = () => Promise.resolve({ repo: true, porcelain: '', clean: true })
    backend.unmerged = () => Promise.resolve(pending)
    backend.resolve = async () => {
      expect(events.some((event) => event.startsWith('commit'))).toBe(false)
      const entries = await files.list('.stride/conflict-checkpoints')
      expect(entries).toHaveLength(1)
      expect(await files.readText(`.stride/conflict-checkpoints/${entries[0]!.name}`)).toBe(marker)
      sawCheckpoint = true
      events.push('resolve')
      pending = []
      await files.writeText('notes/a.md', 'kept ours\n')
    }
    backend.commit = (_repo, message, paths) => {
      events.push(`commit ${message} ${(paths ?? []).join(' ')}`)
      return Promise.resolve(message)
    }
    setGitBackendForTests(backend)
    register(VaultService)
    register(SettingsService)
    register(GitService)
    const vault = resolve(VaultService)
    vault.fs = files
    vault.broad = false
    vault.phase = 'chooser'
    resolve(SettingsService).setGitEnabled(true)
    const git = resolve(GitService)
    await git.keepSide('..', 'ours')
    expect(events).toEqual([])
    expect(sawCheckpoint).toBe(false)
    expect(git.output).toMatch(/escapes the vault/)
    expect(await files.stat('.stride/conflict-checkpoints')).toBeNull()
    expect(await files.readText('notes/a.md')).toBe(marker)
    await git.keepSide('notes/a.md', 'ours')
    expect(sawCheckpoint).toBe(true)
    const resolveAt = events.indexOf('resolve')
    const commitAt = events.findIndex((event) => event.startsWith('commit Checkpoint conflicted file contents'))
    expect(resolveAt).toBeGreaterThanOrEqual(0)
    expect(commitAt).toBeGreaterThan(resolveAt)
    expect(git.conflicts).toEqual([])
    expect(git.output).toBe('')
    const left = await files.list('.stride/conflict-checkpoints')
    expect(left).toHaveLength(1)
    expect(await files.readText(`.stride/conflict-checkpoints/${left[0]!.name}`)).toBe(marker)
    expect(await files.readText('notes/a.md')).toBe('kept ours\n')
  })

  it('clears ahead after a successful push and reports an incompatible remote', async () => {
    let pushed = false
    const removed: string[] = []
    setGitBackendForTests({
      available: true,
      init: () => Promise.resolve(),
      status: () => Promise.resolve({ repo: true, porcelain: '', clean: true }),
      diff: () => Promise.resolve(''),
      commit: () => Promise.resolve(''),
      history: () => Promise.resolve([]),
      show: () => Promise.resolve(''),
      currentBranch: () => Promise.resolve('main'),
      aheadBehind: () => Promise.resolve({ ahead: pushed ? 0 : 3, behind: 1 }),
      remoteUrl: () => Promise.resolve(null),
      addRemote: () => Promise.resolve(),
      fetch: () => Promise.resolve(),
      sharesHistory: () => Promise.resolve(false),
      removeRemote: (_repo, name) => {
        removed.push(name ?? 'origin')
        return Promise.resolve()
      },
      push: () => {
        pushed = true
        return Promise.resolve('pushed')
      },
      pull: () => Promise.resolve({ conflict: false, files: [], output: '' }),
      unmerged: () => Promise.resolve([]),
      resolve: () => Promise.resolve(),
      clone: () => Promise.resolve(),
    })
    register(VaultService)
    register(SettingsService)
    register(GitService)
    const files = new MemoryFileSystem('/tmp/vault-push')
    await files.mkdir('.git')
    const vault = resolve(VaultService)
    vault.fs = files
    vault.broad = false
    resolve(SettingsService).setGitEnabled(true)
    const git = resolve(GitService)
    await git.refresh()
    expect(git.ahead).toBe(3)
    await git.push()
    expect(pushed).toBe(true)
    expect(git.ahead).toBe(0)
    expect(git.behind).toBe(1)
    expect(git.output).toBe('')
    git.setRemote('https://example.test/other.git')
    await git.addRemote()
    expect(removed).toEqual(['origin'])
    expect(git.output).toBe('Remote history is not compatible with this vault')
  })

  it('disables clone and does not call git when the backend is unavailable', async () => {
    const calls: string[] = []
    setGitBackendForTests(recordingClone(calls, false))
    register(VaultService)
    register(GitService)
    const git = resolve(GitService)
    git.surface = 'unavailable'
    const vault = resolve(VaultService)
    vault.phase = 'chooser'
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => {
      root.render(<App />)
    })
    const button = host.querySelector<HTMLButtonElement>('[data-testid="git-clone"]')
    expect(button).not.toBeNull()
    expect(button!.disabled).toBe(true)
    expect(host.querySelector('[data-testid="git-clone-unavailable"]')?.textContent).toBe('git clone needs the desktop app')
    await act(async () => {
      button!.click()
    })
    await git.cloneRemote()
    expect(calls).toEqual([])
    expect(git.cloneError).toBe('git clone needs the desktop app')
    root.unmount()
    host.remove()
  })

  it('clones into the test parent using the repository name', async () => {
    const calls: string[] = []
    setGitBackendForTests(recordingClone(calls))
    setCloneParentForTests('/tmp/vaults')
    register(VaultService)
    register(GitService)
    const git = resolve(GitService)
    const vault = resolve(VaultService)
    git.surface = 'needs-init'
    vault.phase = 'chooser'
    vault.openedClonePath = ''
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => {
      root.render(<App />)
    })
    const input = host.querySelector<HTMLInputElement>('[data-testid="git-clone-url"]')
    const button = host.querySelector<HTMLButtonElement>('[data-testid="git-clone"]')
    expect(button).not.toBeNull()
    expect(button!.disabled).toBe(false)
    expect(host.querySelector('[data-testid="git-clone-unavailable"]')).toBeNull()
    await act(async () => {
      setControlValue(input!, 'https://example.test/notes.git')
    })
    expect(git.cloneUrl).toBe('https://example.test/notes.git')
    await act(async () => {
      button!.click()
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 0))
    })
    expect(calls).toEqual(['clone https://example.test/notes.git /tmp/vaults/notes'])
    expect(vault.openedClonePath).toBe('/tmp/vaults/notes')
    expect(git.cloneError).toBe('')
    expect(vault.phase).toBe('chooser')
    root.unmount()
    host.remove()
  })

  it('does not clone into a non-empty destination', async () => {
    const calls: string[] = []
    setGitBackendForTests(recordingClone(calls))
    setCloneParentForTests('/tmp/vaults')
    const dest = new MemoryFileSystem('/tmp/vaults/notes')
    await dest.writeText('keep.md', 'stay')
    setCloneDestForTests(dest)
    register(VaultService)
    register(GitService)
    const git = resolve(GitService)
    git.setCloneUrl('https://example.test/notes.git')
    await git.cloneRemote()
    expect(calls).toEqual([])
    expect(git.cloneError).toBe('Destination is not empty')
    expect(await dest.readText('keep.md')).toBe('stay')
  })

  it('stores a broad-folder refusal on cloneError', async () => {
    const calls: string[] = []
    setGitBackendForTests(recordingClone(calls))
    setCloneParentForTests('/Users/stride')
    register(VaultService)
    register(GitService)
    const git = resolve(GitService)
    git.setCloneUrl('https://example.test/Desktop.git')
    await git.cloneRemote()
    expect(calls).toEqual([])
    expect(git.cloneError).toBe(DEDICATED_ERROR)
  })

  it('writes a shown revision and does not commit it', async () => {
    const commits: string[] = []
    const current = serializeNote(createNote('a', 'Current'))
    const previous = serializeNote(createNote('a', 'Previous'))
    const backend = recordingGit([])
    backend.history = () => Promise.resolve([{ hash: 'abc', subject: 'Add note' }])
    backend.show = () => Promise.resolve(previous)
    backend.commit = (_repo, message) => {
      commits.push(message)
      return Promise.resolve(message)
    }
    setGitBackendForTests(backend)
    register(VaultService)
    register(SettingsService)
    register(GitService)
    const files = new MemoryFileSystem('/tmp/vault-history')
    await files.writeText('a.stride.json', current)
    const vault = resolve(VaultService)
    vault.fs = files
    vault.notes = [createNote('a', 'Current')]
    vault.activeId = 'a'
    vault.updateDoc({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'unsaved' }] }],
    })
    resolve(SettingsService).setGitEnabled(true)
    const git = resolve(GitService)
    await git.loadHistory()
    await git.showHistory('abc')
    expect(git.historyText).toBe(previous)
    const epoch = vault.docEpoch
    await git.restoreHistory()
    await new Promise((resolveTimer) => setTimeout(resolveTimer, 500))
    expect(await files.readText('a.stride.json')).toBe(previous)
    expect(vault.active?.title).toBe('Previous')
    expect(vault.docEpoch).toBe(epoch + 1)
    expect(commits).toEqual([])
    git.historyText = 'not json'
    await git.restoreHistory()
    expect(git.output).toMatch(/not TipTap JSON/)
    expect(await files.readText('a.stride.json')).toBe(previous)
  })
})

function setControlValue(element: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setter?.call(element, value)
  element.dispatchEvent(new Event('input', { bubbles: true }))
  element.dispatchEvent(new Event('change', { bubbles: true }))
}

function recordingClone(calls: string[], available = true): GitBackend {
  return {
    ...recordingGit(calls),
    available,
    clone: (remote, dest) => {
      calls.push(`clone ${remote} ${dest}`)
      return Promise.resolve()
    },
  }
}

function recordingGit(calls: string[]): GitBackend {
  return {
    available: true,
    init: (repo) => {
      calls.push(`init ${repo}`)
      return Promise.resolve()
    },
    status: () => Promise.resolve({ repo: true, porcelain: '', clean: true }),
    diff: () => Promise.resolve(''),
    commit: (_repo, message) => {
      calls.push(`commit ${message}`)
      return Promise.resolve(message)
    },
    history: () => Promise.resolve([]),
    show: () => Promise.resolve(''),
    currentBranch: () => Promise.resolve('main'),
    remoteUrl: () => Promise.resolve(null),
    addRemote: () => Promise.resolve(),
    fetch: () => Promise.resolve(),
    sharesHistory: () => Promise.resolve(true),
    removeRemote: () => Promise.resolve(),
    push: () => Promise.resolve(''),
    pull: () => Promise.resolve({ conflict: false, files: [], output: '' }),
    unmerged: () => Promise.resolve([]),
    resolve: () => Promise.resolve(),
    clone: () => Promise.resolve(),
    aheadBehind: () => Promise.resolve({ ahead: 0, behind: 0 }),
  }
}

function twoFileGit(
  repo: { porcelain: string },
  commits: Array<{ message: string; paths?: string[] }>,
): GitBackend {
  return {
    available: true,
    init: () => Promise.resolve(),
    status: () => Promise.resolve({ repo: true, porcelain: repo.porcelain, clean: false }),
    diff: (_repo, relPath) => Promise.resolve(`diff ${relPath ?? ''}\n`),
    commit: (_repo, message, paths) => {
      commits.push({ message, paths: paths ? [...paths] : undefined })
      return Promise.resolve(message)
    },
    history: () => Promise.resolve([]),
    show: () => Promise.resolve(''),
    currentBranch: () => Promise.resolve('main'),
    aheadBehind: () => Promise.resolve({ ahead: 1, behind: 0 }),
    remoteUrl: () => Promise.resolve(null),
    addRemote: () => Promise.resolve(),
    fetch: () => Promise.resolve(),
    sharesHistory: () => Promise.resolve(true),
    removeRemote: () => Promise.resolve(),
    push: () => Promise.resolve(''),
    pull: () => Promise.resolve({ conflict: false, files: [], output: '' }),
    unmerged: () => Promise.resolve([]),
    resolve: () => Promise.resolve(),
    clone: () => Promise.resolve(),
  }
}
