import type { FileSystemBackend } from '@stride/platform'
import { VAULT_MARKER } from './vault.ts'

export async function readRenameFromHeading(fs: FileSystemBackend): Promise<boolean> {
  try {
    const stat = await fs.stat(VAULT_MARKER)
    if (!stat || stat.kind !== 'file') return true
    const parsed = JSON.parse(await fs.readText(VAULT_MARKER)) as { renameFromHeading?: unknown }
    if (!parsed || typeof parsed !== 'object') return true
    return typeof parsed.renameFromHeading === 'boolean' ? parsed.renameFromHeading : true
  } catch {
    return true
  }
}

export async function writeRenameFromHeading(fs: FileSystemBackend, enabled: boolean): Promise<void> {
  const stat = await fs.stat(VAULT_MARKER)
  if (!stat || stat.kind !== 'file') return
  let parsed: unknown
  try {
    parsed = JSON.parse(await fs.readText(VAULT_MARKER))
  } catch {
    return
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return
  const next = { ...(parsed as Record<string, unknown>), renameFromHeading: enabled }
  await fs.writeText(VAULT_MARKER, `${JSON.stringify(next, null, 2)}\n`)
}

export async function readAdvanceInbox(fs: FileSystemBackend): Promise<boolean> {
  try {
    const stat = await fs.stat(VAULT_MARKER)
    if (!stat || stat.kind !== 'file') return true
    const parsed = JSON.parse(await fs.readText(VAULT_MARKER)) as { advanceInbox?: unknown }
    if (!parsed || typeof parsed !== 'object') return true
    return typeof parsed.advanceInbox === 'boolean' ? parsed.advanceInbox : true
  } catch {
    return true
  }
}

export async function writeAdvanceInbox(fs: FileSystemBackend, enabled: boolean): Promise<void> {
  const stat = await fs.stat(VAULT_MARKER)
  if (!stat || stat.kind !== 'file') return
  let parsed: unknown
  try {
    parsed = JSON.parse(await fs.readText(VAULT_MARKER))
  } catch {
    return
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return
  const next = { ...(parsed as Record<string, unknown>), advanceInbox: enabled }
  await fs.writeText(VAULT_MARKER, `${JSON.stringify(next, null, 2)}\n`)
}

export type AgentMode = 'safe' | 'power'

export async function readAgentMode(fs: FileSystemBackend): Promise<AgentMode> {
  try {
    const stat = await fs.stat(VAULT_MARKER)
    if (!stat || stat.kind !== 'file') return 'safe'
    const parsed = JSON.parse(await fs.readText(VAULT_MARKER)) as { agentMode?: unknown }
    if (!parsed || typeof parsed !== 'object') return 'safe'
    return parsed.agentMode === 'power' || parsed.agentMode === 'safe' ? parsed.agentMode : 'safe'
  } catch {
    return 'safe'
  }
}

export async function writeAgentMode(fs: FileSystemBackend, mode: AgentMode): Promise<void> {
  const stat = await fs.stat(VAULT_MARKER)
  if (!stat || stat.kind !== 'file') return
  let parsed: unknown
  try {
    parsed = JSON.parse(await fs.readText(VAULT_MARKER))
  } catch {
    return
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return
  const next = { ...(parsed as Record<string, unknown>), agentMode: mode }
  await fs.writeText(VAULT_MARKER, `${JSON.stringify(next, null, 2)}\n`)
}
