import { has, resolve } from '@rabjs/react'
import {
  applyViewsOrder,
  buildAgentContext,
  deleteVaultView,
  listViews,
  plainText,
  readViewsOrder,
  redactSecret,
  saveVaultView,
  VAULT_ASSISTANT_PROMPT,
  VAULT_MEMORY_PROMPT,
  type VaultToolHost,
} from '@stride/core'
import { ShellAbortError, ShellTimeoutError, type ShellOutput } from '@stride/platform'
import { resolveShellBackend } from '../platform/shell'
import { SettingsService } from '../settings/settings.service'
import { VaultService } from '../vault/vault.service'
import { ViewsService } from '../views/views.service'

export function chatSystemPrompt(vault: VaultService, memorySection = '', memoryPrompt = true): string {
  const active = vault.active
  const snapshot = buildAgentContext({
    activeNote: active
      ? {
          id: active.id,
          title: active.title,
          type: active.type,
          properties: active.properties,
          text: plainText(active.doc),
        }
      : null,
    openTabs: active ? [{ id: active.id, title: active.title }] : [],
    vault: {
      label: vault.currentVaultLabel,
      noteCount: vault.notes.length,
      titles: vault.notes.map((note) => note.title),
    },
  })
  // memoryPrompt=false when long-term memory is disabled: no tools are
  // mounted, so the prompt must not claim they exist.
  return `${snapshot}${memorySection ? `\n${memorySection}\n` : ''}\n${VAULT_ASSISTANT_PROMPT}${memoryPrompt ? `\n${VAULT_MEMORY_PROMPT}` : ''}`
}

function liveViews(vault: VaultService): boolean {
  return has(VaultService) && resolve(VaultService) === vault && has(ViewsService) && Boolean(vault.fs)
}

function configuredSecretsLongestFirst(): string[] {
  if (!has(SettingsService)) return []
  const secrets = resolve(SettingsService).configuredSecretValues().filter((secret) => secret !== '')
  // Longest first so a shorter prefix cannot split a longer key.
  return [...secrets].sort((left, right) => right.length - left.length)
}

function redactShellOutput(output: ShellOutput): ShellOutput {
  const secrets = configuredSecretsLongestFirst()
  if (secrets.length === 0) return output
  let stdout = output.stdout
  let stderr = output.stderr
  for (const secret of secrets) {
    stdout = redactSecret(stdout, secret)
    stderr = redactSecret(stderr, secret)
  }
  return { ...output, stdout, stderr }
}

export function chatVaultHost(vault: VaultService): VaultToolHost {
  return {
    get activeNoteId() {
      return vault.activeId || undefined
    },
    readNote(id) {
      const note = vault.notes.find((item) => item.id === id)
      if (!note) throw new Error('Note not found')
      return note
    },
    async writeSerialized(id, serialized) {
      await vault.writeExternalNote(id, serialized)
    },
    async searchVault(query) {
      const hits = await vault.queryRanked(query)
      return hits.map((hit) => ({
        id: hit.id,
        title: vault.notes.find((note) => note.id === hit.id)?.title ?? hit.id,
        snippet: hit.snippet,
      }))
    },
    loadNotes() {
      return vault.notes
    },
    async createNote(title) {
      if (!vault.fs) throw new Error('Open a vault first')
      const before = new Set(vault.notes.map((note) => note.id))
      vault.error = ''
      await vault.createLinkedNote(title)
      if (vault.error) throw new Error(vault.error)
      const created = vault.notes.find((note) => !before.has(note.id))
      if (!created) throw new Error('Could not create the note')
      return created
    },
    views: {
      async list() {
        if (liveViews(vault)) return resolve(ViewsService).views
        if (!vault.fs) throw new Error('Open a vault first')
        return applyViewsOrder(await listViews(vault.fs), await readViewsOrder(vault.fs))
      },
      async save(input) {
        if (liveViews(vault)) {
          const saved = await resolve(ViewsService).saveView(input)
          if (!saved) throw new Error('Open a vault first')
          return saved
        }
        if (!vault.fs) throw new Error('Open a vault first')
        return saveVaultView(vault.fs, input)
      },
      async remove(file) {
        if (liveViews(vault)) {
          const views = resolve(ViewsService)
          if (!views.byFile(file)) throw new Error('View not found')
          await views.deleteView(file)
          return
        }
        if (!vault.fs) throw new Error('Open a vault first')
        await deleteVaultView(vault.fs, file)
      },
    },
    shell: {
      async exec(command, options) {
        if (!vault.fs) throw new Error('Open a vault first')
        const backend = await resolveShellBackend()
        if (!backend.available) throw new Error('Shell is not available in the browser')
        try {
          const output = await backend.exec({
            command,
            cwd: vault.fs.rootLabel,
            timeoutSeconds: options?.timeout,
            signal: options?.signal,
          })
          return redactShellOutput(output)
        } catch (error) {
          if (error instanceof ShellAbortError) {
            throw new ShellAbortError(redactShellOutput(error.output))
          }
          if (error instanceof ShellTimeoutError) {
            throw new ShellTimeoutError(error.seconds, redactShellOutput(error.output))
          }
          throw error
        }
      },
    },
  }
}
