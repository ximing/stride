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
