import { isExternalAgentMode, type ExternalAgentMode, type FileSystemBackend } from '@stride/platform'

export { isExternalAgentMode }
import { TYPE_COLOR_KEYS } from './types.ts'
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

export type AgentMode = 'safe' | 'power' | ExternalAgentMode

export function isAgentMode(value: string): value is AgentMode {
  return value === 'safe' || value === 'power' || isExternalAgentMode(value)
}

/** Unknown marker values stay on Safe. */
export function sanitizeAgentMode(value: unknown): AgentMode {
  return typeof value === 'string' && isAgentMode(value) ? value : 'safe'
}

export async function readAgentMode(fs: FileSystemBackend): Promise<AgentMode> {
  try {
    const stat = await fs.stat(VAULT_MARKER)
    if (!stat || stat.kind !== 'file') return 'safe'
    const parsed = JSON.parse(await fs.readText(VAULT_MARKER)) as { agentMode?: unknown }
    if (!parsed || typeof parsed !== 'object') return 'safe'
    return sanitizeAgentMode(parsed.agentMode)
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

// ---------- T7.3 per-vault settings ----------
// Shared read-modify-write helpers; every writer spreads the existing marker
// object so unknown fields (and fields owned by other flags) survive a write.

async function readMarker(fs: FileSystemBackend): Promise<Record<string, unknown> | null> {
  try {
    const stat = await fs.stat(VAULT_MARKER)
    if (!stat || stat.kind !== 'file') return null
    const parsed: unknown = JSON.parse(await fs.readText(VAULT_MARKER))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

async function patchMarker(fs: FileSystemBackend, patch: Record<string, unknown>): Promise<void> {
  const marker = await readMarker(fs)
  if (!marker) return
  await fs.writeText(VAULT_MARKER, `${JSON.stringify({ ...marker, ...patch }, null, 2)}\n`)
}

export const VAULT_ZOOM_MIN = 0.7
export const VAULT_ZOOM_MAX = 1.6
export const VAULT_ZOOM_DEFAULT = 1

/** Zoom is valid only inside [VAULT_ZOOM_MIN, VAULT_ZOOM_MAX]; anything else falls back to 1. */
export function sanitizeZoom(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= VAULT_ZOOM_MIN && value <= VAULT_ZOOM_MAX
    ? value
    : VAULT_ZOOM_DEFAULT
}

export async function readZoom(fs: FileSystemBackend): Promise<number> {
  return sanitizeZoom((await readMarker(fs))?.zoom)
}

export async function writeZoom(fs: FileSystemBackend, zoom: number): Promise<void> {
  await patchMarker(fs, { zoom: sanitizeZoom(zoom) })
}

export type ViewMode = 'comfortable' | 'compact'

export function sanitizeViewMode(value: unknown): ViewMode {
  return value === 'compact' || value === 'comfortable' ? value : 'comfortable'
}

export async function readViewMode(fs: FileSystemBackend): Promise<ViewMode> {
  return sanitizeViewMode((await readMarker(fs))?.viewMode)
}

export async function writeViewMode(fs: FileSystemBackend, viewMode: ViewMode): Promise<void> {
  await patchMarker(fs, { viewMode: sanitizeViewMode(viewMode) })
}

export type GitSetupPreference = 'undecided' | 'enabled' | 'disabled'

export function sanitizeGitSetupPreference(value: unknown): GitSetupPreference {
  return value === 'enabled' || value === 'disabled' || value === 'undecided' ? value : 'undecided'
}

export async function readGitSetupPreference(fs: FileSystemBackend): Promise<GitSetupPreference> {
  return sanitizeGitSetupPreference((await readMarker(fs))?.gitSetupPreference)
}

export async function writeGitSetupPreference(fs: FileSystemBackend, preference: GitSetupPreference): Promise<void> {
  await patchMarker(fs, { gitSetupPreference: sanitizeGitSetupPreference(preference) })
}

// ---------- tag colors ----------
// User-chosen colors for `#tag` chips, keyed by the trimmed tag name. Values
// are the eight real colors; `gray` means "auto" (hash the name), matching
// resolveEntityColor. Unknown tags/colors are dropped on sanitize.

export type TagColors = Record<string, string>

export function sanitizeTagColors(value: unknown): TagColors {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const colors: TagColors = {}
  for (const [tag, color] of Object.entries(value as Record<string, unknown>)) {
    const name = tag.trim()
    const key = typeof color === 'string' ? color.trim().toLowerCase() : ''
    if (!name || !(TYPE_COLOR_KEYS as readonly string[]).includes(key)) continue
    colors[name] = key
  }
  return colors
}

export async function readTagColors(fs: FileSystemBackend): Promise<TagColors> {
  return sanitizeTagColors((await readMarker(fs))?.tagColors)
}

export interface VaultOpenState {
  renameFromHeading: boolean
  advanceInbox: boolean
  agentMode: AgentMode
  zoom: number
  viewMode: ViewMode
  gitSetupPreference: GitSetupPreference
  tagColors: TagColors
}

/** One marker read for the flags an open publishes together. Defaults match the individual readers. */
export async function readVaultOpenState(fs: FileSystemBackend): Promise<VaultOpenState> {
  const marker = await readMarker(fs)
  const agentMode = sanitizeAgentMode(marker?.agentMode)
  return {
    renameFromHeading: typeof marker?.renameFromHeading === 'boolean' ? marker.renameFromHeading : true,
    advanceInbox: typeof marker?.advanceInbox === 'boolean' ? marker.advanceInbox : true,
    agentMode,
    zoom: sanitizeZoom(marker?.zoom),
    viewMode: sanitizeViewMode(marker?.viewMode),
    gitSetupPreference: sanitizeGitSetupPreference(marker?.gitSetupPreference),
    tagColors: sanitizeTagColors(marker?.tagColors),
  }
}

export async function writeTagColors(fs: FileSystemBackend, colors: TagColors): Promise<void> {
  await patchMarker(fs, { tagColors: sanitizeTagColors(colors) })
}
