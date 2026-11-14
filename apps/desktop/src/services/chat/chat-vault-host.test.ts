import { has, register, resolve } from '@rabjs/react'
import {
  MemoryFileSystem,
  ShellAbortError,
  ShellDeniedError,
  ShellTimeoutError,
  type ShellBackend,
  type ShellExecOptions,
} from '@stride/platform'
import { createNote, saveNote, type StrideNote } from '@stride/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { chatSystemPrompt, chatVaultHost } from './chat-vault-host'
import { TabsService } from '../notes/tabs.service'
import { SettingsService } from '../settings/settings.service'
import { FolderService } from '../vault/folder.service'
import { VaultService } from '../vault/vault.service'

const shortKey = 'sk-short'
const longKey = 'sk-short-and-more'

function writableHost(vault: VaultService) {
  const host = chatVaultHost(vault)
  if (!host.deleteNote || !host.moveNote) throw new Error('Vault host is missing write tools')
  return host as typeof host & {
    deleteNote: NonNullable<(typeof host)['deleteNote']>
    moveNote: NonNullable<(typeof host)['moveNote']>
  }
}

const shellGate = vi.hoisted(() => ({
  desktop: false,
  backend: null as ShellBackend | null,
}))

vi.mock('../platform/runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../platform/runtime')>()
  return {
    ...actual,
    isDesktopRuntime: () => shellGate.desktop,
  }
})

vi.mock('../platform/shell', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../platform/shell')>()
  return {
    ...actual,
    resolveShellBackend: async () => {
      if (shellGate.backend === null) return actual.resolveShellBackend()
      return shellGate.backend
    },
  }
})

function useDesktopShell(exec: ShellBackend['exec']): ShellExecOptions[] {
  const calls: ShellExecOptions[] = []
  shellGate.desktop = true
  shellGate.backend = {
    available: true,
    exec: (options) => {
      calls.push(options)
      return exec(options)
    },
  }
  return calls
}

function shellVault(rootLabel: string): VaultService {
  return { fs: { rootLabel } } as unknown as VaultService
}

async function withConfiguredSecrets(run: () => Promise<void>) {
  if (!has(SettingsService)) register(SettingsService)
  const settings = resolve(SettingsService)
  const internals = settings as unknown as {
    memoryLlmKeys: Record<string, string>
    memoryEmbeddingKey: string
  }
  const previousKeys = internals.memoryLlmKeys
  const previousEmbedding = internals.memoryEmbeddingKey
  const previousForm = settings.form
  internals.memoryLlmKeys = { cfg_a: shortKey }
  internals.memoryEmbeddingKey = longKey
  settings.form = {
    ...settings.form,
    llmConfigs: [
      { id: 'cfg_a', name: 'A', provider: 'openai', model: 'gpt-4o-mini', baseUrl: '', keyMask: '', isDefault: true },
    ],
  }
  try {
    expect(settings.configuredSecretValues()).toEqual([shortKey, longKey])
    await run()
    expect(settings.configuredSecretValues()).toEqual([shortKey, longKey])
  } finally {
    internals.memoryLlmKeys = previousKeys
    internals.memoryEmbeddingKey = previousEmbedding
    settings.form = previousForm
  }
}

async function rejectedExec(command: string): Promise<unknown> {
  try {
    await chatVaultHost(shellVault('/vault')).shell!.exec(command)
  } catch (error) {
    return error
  }
  throw new Error('expected shell exec to reject')
}

const note: StrideNote = {
  id: 'n1',
  title: 'Moss garden',
  type: 'note',
  properties: {},
  doc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'ferns by the wall' }] }] },
}

describe('chatVaultHost', () => {
  afterEach(() => {
    shellGate.desktop = false
    shellGate.backend = null
  })

  it('searches the open vault without writing the search panel query', async () => {
    if (!has(VaultService)) register(VaultService)
    const vault = resolve(VaultService)
    const previousNotes = vault.notes
    const previousQuery = vault.searchQuery
    vault.notes = [note]
    vault.searchQuery = ''
    try {
      const hits = await chatVaultHost(vault).searchVault('Moss')
      expect(hits[0]?.id).toBe('n1')
      expect(hits[0]?.title).toBe('Moss garden')
      expect(hits[0]?.snippet).toContain('Moss')
      expect(vault.searchQuery).toBe('')
    } finally {
      vault.notes = previousNotes
      vault.searchQuery = previousQuery
    }
  })

  it('puts the open note title in the system prompt and leaves keys out', () => {
    const vault = {
      active: note,
      notes: [note],
      currentVaultLabel: 'Field notes',
    } as unknown as VaultService
    const prompt = chatSystemPrompt(vault)
    expect(prompt).toContain('Moss garden')
    expect(prompt).toContain('ferns by the wall')
    expect(prompt).toContain('list_types')
    expect(prompt).toContain('save_view')
    expect(prompt).toContain('bash')
    expect(prompt).toContain('delete_note')
    expect(prompt).toContain('move_note')
    expect(prompt).toContain('Do not rewrite *.stride.json from the shell.')
    expect(prompt).not.toContain('Do not delete notes')
    expect(prompt).toContain('memory_read')
    expect(prompt).toContain('memory_write')
    expect(prompt).not.toContain('apiKey')
  })

  it('inserts the memory section between the snapshot and the prompts', () => {
    const vault = {
      active: note,
      notes: [note],
      currentVaultLabel: 'Field notes',
    } as unknown as VaultService
    const section = '## Long-term memory index\n\n### Project memory (this vault)\n- [fact] Stack — Tauri 2 (mem_1)'
    const prompt = chatSystemPrompt(vault, section)
    expect(prompt).toContain(`${section}\n`)
    expect(prompt.indexOf('ferns by the wall')).toBeLessThan(prompt.indexOf(section))
    expect(prompt.indexOf(section)).toBeLessThan(prompt.indexOf('list_types'))
    // No memory section: snapshot flows straight into the prompts.
    const bare = chatSystemPrompt(vault)
    expect(bare).not.toContain('Long-term memory index')
  })

  it('says when no note is open', () => {
    const vault = {
      active: null,
      notes: [],
      currentVaultLabel: '',
    } as unknown as VaultService
    expect(chatSystemPrompt(vault)).toContain('No note is open')
  })

  it('passes TabsService tabs, capped at 20, instead of only the active note', () => {
    if (!has(TabsService)) register(TabsService)
    const tabs = resolve(TabsService)
    const previous = tabs.tabs
    const notes = Array.from({ length: 21 }, (_, index) => ({
      ...note,
      id: `n${index}`,
      title: `Tab ${index}`,
    }))
    tabs.tabs = notes.map((item, index) => ({
      id: `tab-${index}`,
      noteId: item.id,
      back: [],
      forward: [],
    }))
    const vault = {
      active: notes[0],
      notes,
      currentVaultLabel: 'Field',
    } as unknown as VaultService
    try {
      const prompt = chatSystemPrompt(vault)
      expect(prompt).toContain('Open tabs show 20 of 21.')
      expect(prompt).toContain('"tabsShown": 20')
      expect(prompt).toContain('"tabsTruncated": true')
      expect(prompt).toContain('"title": "Tab 19"')
      expect(prompt).not.toContain('"title": "Tab 20"')
      expect(prompt).not.toContain('Vault titles show')
      const openTabs = prompt.slice(prompt.indexOf('"openTabs"'), prompt.indexOf('"tabsShown"'))
      expect(openTabs).toContain('"id": "n0"')
      expect(openTabs).not.toContain('only-the-active-note')
    } finally {
      tabs.tabs = previous
    }
  })

  it('deletes a note through VaultService.deleteNotes', async () => {
    const calls: string[][] = []
    const vault = {
      fs: { rootLabel: '/vault' },
      error: '',
      deleteNotes: async (ids: string[]) => {
        calls.push([...ids])
      },
    } as unknown as VaultService
    await writableHost(vault).deleteNote('n1')
    expect(calls).toEqual([['n1']])
    const failing = {
      fs: { rootLabel: '/vault' },
      error: '',
      deleteNotes: async () => {
        failing.error = 'disk full'
      },
    } as unknown as VaultService & { error: string }
    await expect(writableHost(failing).deleteNote('n1')).rejects.toThrow('disk full')
  })

  it('moves a note through FolderService and does not create the destination', async () => {
    if (!has(VaultService)) register(VaultService)
    if (!has(FolderService)) register(FolderService)
    const vault = resolve(VaultService)
    const fs = new MemoryFileSystem('/tmp/stride-chat-move')
    const moving = createNote('alpha', 'Alpha')
    await saveNote(fs, moving)
    await fs.mkdir('box')
    const previous = {
      fs: vault.fs,
      notes: vault.notes,
      activeId: vault.activeId,
      error: vault.error,
      docEpoch: vault.docEpoch,
    }
    vault.fs = fs
    vault.notes = [moving]
    vault.activeId = moving.id
    vault.error = ''
    try {
      await expect(writableHost(vault).moveNote('alpha', 'missing')).rejects.toThrow('Folder not found')
      expect(await fs.stat('missing')).toBeNull()
      expect(await fs.stat('alpha.stride.json')).not.toBeNull()
      expect(await writableHost(vault).moveNote('alpha', 'box')).toEqual({ id: 'box/alpha' })
      expect(vault.notes.map((item) => item.id)).toEqual(['box/alpha'])
      expect(vault.error).toBe('')
      expect(await writableHost(vault).moveNote('box/alpha', '')).toEqual({ id: 'alpha' })
      expect(await fs.stat('alpha.stride.json')).not.toBeNull()
    } finally {
      vault.fs = previous.fs
      vault.notes = previous.notes
      vault.activeId = previous.activeId
      vault.error = previous.error
      vault.docEpoch = previous.docEpoch
    }
  })

  it('refuses to delete or move when no vault is open', async () => {
    const vault = { fs: null, notes: [], error: '' } as unknown as VaultService
    await expect(writableHost(vault).deleteNote('n1')).rejects.toThrow('Open a vault first')
    await expect(writableHost(vault).moveNote('n1', 'box')).rejects.toThrow('Open a vault first')
  })

  it('refuses to create a note when no vault is open', async () => {
    const vault = { fs: null, notes: [], activeId: '' } as unknown as VaultService
    await expect(chatVaultHost(vault).createNote('A seed')).rejects.toThrow('Open a vault first')
  })

  it('refuses shell without a vault and in the browser', async () => {
    const closed = { fs: null } as unknown as VaultService
    await expect(chatVaultHost(closed).shell?.exec('echo hi')).rejects.toThrow('Open a vault first')
    const browser = { fs: { rootLabel: '/vault' } } as unknown as VaultService
    await expect(chatVaultHost(browser).shell?.exec('echo hi')).rejects.toThrow('Shell is not available in the browser')
  })

  it('saves a view through the vault filesystem when this vault is not the open service', async () => {
    const fs = new MemoryFileSystem('/tmp/stride-chat-views')
    const vault = { fs, notes: [], activeId: '', listFilter: 'all' } as unknown as VaultService
    const host = chatVaultHost(vault)
    const saved = await host.views!.save({ view: { version: 1, name: 'Open projects', type: 'Project' } })
    expect(saved.file).toBe('open-projects')
    expect((await host.views!.list()).map((item) => item.file)).toEqual(['open-projects'])
  })

  it('replaces a longer secret before a shorter prefix', async () => {
    await withConfiguredSecrets(async () => {
      useDesktopShell(async () => ({ stdout: longKey, stderr: shortKey, code: null, truncated: true }))
      const output = await chatVaultHost(shellVault('/vault')).shell!.exec('echo hi')
      expect(output).toEqual({ stdout: '••••', stderr: '••••', code: null, truncated: true })
      console.log('long key fully replaced with ••••')
    })
  })

  it('redacts ShellTimeoutError output and keeps fractional seconds', async () => {
    await withConfiguredSecrets(async () => {
      const original = new ShellTimeoutError(12.5, { stdout: longKey, stderr: '', code: null })
      useDesktopShell(() => Promise.reject(original))
      const caught = await rejectedExec('sleep 12')
      expect(caught).toBeInstanceOf(ShellTimeoutError)
      expect(caught).not.toBe(original)
      const timeout = caught as ShellTimeoutError
      expect(timeout.seconds).toBe(12.5)
      expect(timeout.message).toBe('timeout:12.5')
      expect(timeout.output).toEqual({ stdout: '••••', stderr: '', code: null })
      expect(original.output.stdout).toBe(longKey)
      console.log('ShellTimeoutError seconds 12.5')
    })
  })

  it('passes ShellDeniedError through unchanged', async () => {
    await withConfiguredSecrets(async () => {
      const denied = new ShellDeniedError(longKey)
      useDesktopShell(() => Promise.reject(denied))
      const caught = await rejectedExec('echo hi')
      expect(caught).toBe(denied)
      expect(denied.message).toBe(`denied:${longKey}`)
      console.log('ShellDeniedError passed through unchanged')
    })
  })

  it('sends the vault root as cwd and does not redact the command', async () => {
    await withConfiguredSecrets(async () => {
      const command = `echo ${longKey}`
      const calls = useDesktopShell(async () => ({ stdout: longKey, stderr: '', code: 0 }))
      const output = await chatVaultHost(shellVault('/vault/field-notes')).shell!.exec(command)
      expect(calls).toHaveLength(1)
      expect(calls[0]?.cwd).toBe('/vault/field-notes')
      expect(calls[0]?.command).toBe(command)
      expect(output.stdout).toBe('••••')
      console.log('cwd received /vault/field-notes')
    })
  })

  it('redacts ShellAbortError output and keeps the error class', async () => {
    await withConfiguredSecrets(async () => {
      const original = new ShellAbortError({ stdout: longKey, stderr: shortKey, code: null })
      useDesktopShell(() => Promise.reject(original))
      const caught = await rejectedExec('echo hi')
      expect(caught).toBeInstanceOf(ShellAbortError)
      expect(caught).not.toBe(original)
      const aborted = caught as ShellAbortError
      expect(aborted.message).toBe('aborted')
      expect(aborted.output).toEqual({ stdout: '••••', stderr: '••••', code: null })
      expect(original.output.stdout).toBe(longKey)
      console.log('ShellAbortError still ShellAbortError')
    })
  })

  it('rethrows a plain error as the same instance', async () => {
    await withConfiguredSecrets(async () => {
      const failure = new Error(`token ${longKey}`)
      useDesktopShell(() => Promise.reject(failure))
      const caught = await rejectedExec('echo hi')
      expect(caught).toBe(failure)
      expect(failure.message).toBe(`token ${longKey}`)
    })
  })
})
