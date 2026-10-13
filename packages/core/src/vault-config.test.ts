import { MemoryFileSystem } from '@stride/platform'
import { describe, expect, it } from 'vitest'
import { markDedicatedVault } from './vault.ts'
import {
  readAdvanceInbox,
  readRenameFromHeading,
  writeAdvanceInbox,
  writeRenameFromHeading,
} from './vault-config.ts'

describe('advanceInbox vault flag', () => {
  it('defaults to true when the marker is missing or unreadable', async () => {
    const missing = new MemoryFileSystem('missing')
    expect(await readAdvanceInbox(missing)).toBe(true)

    const broken = new MemoryFileSystem('broken')
    await broken.writeText('.stride/vault.json', '{')
    expect(await readAdvanceInbox(broken)).toBe(true)
    await writeAdvanceInbox(broken, false)
    expect(await broken.readText('.stride/vault.json')).toBe('{')
    expect(await readAdvanceInbox(broken)).toBe(true)

    const empty = new MemoryFileSystem('empty')
    await empty.writeText('.stride/vault.json', 'null')
    expect(await readAdvanceInbox(empty)).toBe(true)
  })

  it('merges advanceInbox and keeps kind and renameFromHeading', async () => {
    const fs = new MemoryFileSystem('field-notes')
    await markDedicatedVault(fs)
    await writeRenameFromHeading(fs, false)
    await writeAdvanceInbox(fs, false)
    const marker = JSON.parse(await fs.readText('.stride/vault.json')) as {
      kind?: string
      version?: number
      renameFromHeading?: boolean
      advanceInbox?: boolean
    }
    expect(marker.kind).toBe('stride-vault')
    expect(marker.version).toBe(1)
    expect(marker.renameFromHeading).toBe(false)
    expect(marker.advanceInbox).toBe(false)
    expect(await readAdvanceInbox(fs)).toBe(false)
    expect(await readRenameFromHeading(fs)).toBe(false)

    await writeAdvanceInbox(fs, true)
    expect(await readAdvanceInbox(fs)).toBe(true)
    expect(await readRenameFromHeading(fs)).toBe(false)
  })
})
