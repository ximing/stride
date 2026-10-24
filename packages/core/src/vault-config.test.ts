import { MemoryFileSystem } from '@stride/platform'
import { describe, expect, it } from 'vitest'
import { markDedicatedVault } from './vault.ts'
import {
  readAdvanceInbox,
  readAgentMode,
  readGitSetupPreference,
  readRenameFromHeading,
  readTagColors,
  readViewMode,
  readZoom,
  sanitizeGitSetupPreference,
  sanitizeTagColors,
  sanitizeViewMode,
  sanitizeZoom,
  writeAdvanceInbox,
  writeAgentMode,
  writeGitSetupPreference,
  writeRenameFromHeading,
  writeTagColors,
  writeViewMode,
  writeZoom,
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

describe('agentMode vault flag', () => {
  it('reads safe for a missing or broken marker and round-trips power then safe', async () => {
    const missing = new MemoryFileSystem('missing-mode')
    expect(await readAgentMode(missing)).toBe('safe')

    const broken = new MemoryFileSystem('broken-mode')
    await broken.writeText('.stride/vault.json', '{')
    expect(await readAgentMode(broken)).toBe('safe')
    await writeAgentMode(broken, 'power')
    expect(await broken.readText('.stride/vault.json')).toBe('{')
    expect(await readAgentMode(broken)).toBe('safe')

    const fs = new MemoryFileSystem('field-notes-mode')
    await markDedicatedVault(fs)
    await writeRenameFromHeading(fs, false)
    await writeAgentMode(fs, 'power')
    const powered = JSON.parse(await fs.readText('.stride/vault.json')) as {
      kind?: string
      version?: number
      renameFromHeading?: boolean
      agentMode?: string
    }
    expect(powered.kind).toBe('stride-vault')
    expect(powered.version).toBe(1)
    expect(powered.renameFromHeading).toBe(false)
    expect(powered.agentMode).toBe('power')
    expect(await readAgentMode(fs)).toBe('power')

    await writeAgentMode(fs, 'safe')
    const restored = JSON.parse(await fs.readText('.stride/vault.json')) as {
      kind?: string
      version?: number
      renameFromHeading?: boolean
      agentMode?: string
    }
    expect(restored.kind).toBe('stride-vault')
    expect(restored.version).toBe(1)
    expect(restored.renameFromHeading).toBe(false)
    expect(restored.agentMode).toBe('safe')
    expect(await readAgentMode(fs)).toBe('safe')
  })
})

describe('zoom vault setting (T7.3)', () => {
  it('defaults to 1 when the marker is missing, broken, or not an object', async () => {
    expect(await readZoom(new MemoryFileSystem('zoom-missing'))).toBe(1)

    const broken = new MemoryFileSystem('zoom-broken')
    await broken.writeText('.stride/vault.json', '{')
    expect(await readZoom(broken)).toBe(1)
    // A broken marker is left untouched by writes.
    await writeZoom(broken, 1.2)
    expect(await broken.readText('.stride/vault.json')).toBe('{')

    const empty = new MemoryFileSystem('zoom-null')
    await empty.writeText('.stride/vault.json', 'null')
    expect(await readZoom(empty)).toBe(1)
  })

  it('falls back to 1 for illegal stored values', async () => {
    for (const value of ['"big"', '0.5', '2', '-1', 'true', '[1.2]']) {
      const fs = new MemoryFileSystem(`zoom-illegal-${value}`)
      await fs.writeText('.stride/vault.json', `{"zoom": ${value}}`)
      expect(await readZoom(fs)).toBe(1)
    }
  })

  it('accepts boundary values and round-trips, merging without dropping fields', async () => {
    const fs = new MemoryFileSystem('zoom-round')
    await markDedicatedVault(fs)
    await writeRenameFromHeading(fs, false)
    await fs.writeText(
      '.stride/vault.json',
      `${JSON.stringify({ ...JSON.parse(await fs.readText('.stride/vault.json')), futureField: { nested: true } }, null, 2)}\n`,
    )

    await writeZoom(fs, 0.7)
    expect(await readZoom(fs)).toBe(0.7)
    await writeZoom(fs, 1.6)
    expect(await readZoom(fs)).toBe(1.6)
    await writeZoom(fs, 1.25)
    expect(await readZoom(fs)).toBe(1.25)

    const marker = JSON.parse(await fs.readText('.stride/vault.json')) as Record<string, unknown>
    expect(marker.kind).toBe('stride-vault')
    expect(marker.renameFromHeading).toBe(false)
    expect(marker.futureField).toEqual({ nested: true })
    expect(marker.zoom).toBe(1.25)
  })

  it('sanitizeZoom accepts in-range numbers and rejects everything else', () => {
    expect(sanitizeZoom(0.7)).toBe(0.7)
    expect(sanitizeZoom(1.6)).toBe(1.6)
    expect(sanitizeZoom(1)).toBe(1)
    expect(sanitizeZoom(0.69)).toBe(1)
    expect(sanitizeZoom(1.61)).toBe(1)
    expect(sanitizeZoom(Number.NaN)).toBe(1)
    expect(sanitizeZoom(Number.POSITIVE_INFINITY)).toBe(1)
    expect(sanitizeZoom('1.2')).toBe(1)
    expect(sanitizeZoom(undefined)).toBe(1)
  })
})

describe('viewMode vault setting (T7.3)', () => {
  it('defaults to comfortable when missing, broken, or illegal', async () => {
    expect(await readViewMode(new MemoryFileSystem('vm-missing'))).toBe('comfortable')

    const broken = new MemoryFileSystem('vm-broken')
    await broken.writeText('.stride/vault.json', '{')
    expect(await readViewMode(broken)).toBe('comfortable')
    await writeViewMode(broken, 'compact')
    expect(await broken.readText('.stride/vault.json')).toBe('{')

    const illegal = new MemoryFileSystem('vm-illegal')
    await illegal.writeText('.stride/vault.json', '{"viewMode": "dense"}')
    expect(await readViewMode(illegal)).toBe('comfortable')
  })

  it('round-trips compact and preserves other fields', async () => {
    const fs = new MemoryFileSystem('vm-round')
    await markDedicatedVault(fs)
    await writeZoom(fs, 1.2)
    await writeViewMode(fs, 'compact')
    expect(await readViewMode(fs)).toBe('compact')
    const marker = JSON.parse(await fs.readText('.stride/vault.json')) as Record<string, unknown>
    expect(marker.kind).toBe('stride-vault')
    expect(marker.zoom).toBe(1.2)

    await writeViewMode(fs, 'comfortable')
    expect(await readViewMode(fs)).toBe('comfortable')
    expect(sanitizeViewMode('compact')).toBe('compact')
    expect(sanitizeViewMode('dense')).toBe('comfortable')
    expect(sanitizeViewMode(undefined)).toBe('comfortable')
  })
})

describe('gitSetupPreference vault setting (T7.3)', () => {
  it('defaults to undecided when missing, broken, or illegal', async () => {
    expect(await readGitSetupPreference(new MemoryFileSystem('gp-missing'))).toBe('undecided')

    const broken = new MemoryFileSystem('gp-broken')
    await broken.writeText('.stride/vault.json', '{')
    expect(await readGitSetupPreference(broken)).toBe('undecided')
    await writeGitSetupPreference(broken, 'enabled')
    expect(await broken.readText('.stride/vault.json')).toBe('{')

    const illegal = new MemoryFileSystem('gp-illegal')
    await illegal.writeText('.stride/vault.json', '{"gitSetupPreference": "yes"}')
    expect(await readGitSetupPreference(illegal)).toBe('undecided')
  })

  it('round-trips enabled/disabled/undecided and preserves other fields', async () => {
    const fs = new MemoryFileSystem('gp-round')
    await markDedicatedVault(fs)
    await writeViewMode(fs, 'compact')

    await writeGitSetupPreference(fs, 'enabled')
    expect(await readGitSetupPreference(fs)).toBe('enabled')
    await writeGitSetupPreference(fs, 'disabled')
    expect(await readGitSetupPreference(fs)).toBe('disabled')
    await writeGitSetupPreference(fs, 'undecided')
    expect(await readGitSetupPreference(fs)).toBe('undecided')

    const marker = JSON.parse(await fs.readText('.stride/vault.json')) as Record<string, unknown>
    expect(marker.kind).toBe('stride-vault')
    expect(marker.viewMode).toBe('compact')
    expect(marker.gitSetupPreference).toBe('undecided')

    expect(sanitizeGitSetupPreference('enabled')).toBe('enabled')
    expect(sanitizeGitSetupPreference('maybe')).toBe('undecided')
    expect(sanitizeGitSetupPreference(null)).toBe('undecided')
  })
})

describe('tagColors vault setting', () => {
  it('defaults to {} when the marker is missing, broken, or not an object', async () => {
    expect(await readTagColors(new MemoryFileSystem('tc-missing'))).toEqual({})

    const broken = new MemoryFileSystem('tc-broken')
    await broken.writeText('.stride/vault.json', '{')
    expect(await readTagColors(broken)).toEqual({})
    await writeTagColors(broken, { alpha: 'blue' })
    expect(await broken.readText('.stride/vault.json')).toBe('{')

    const illegal = new MemoryFileSystem('tc-illegal')
    await illegal.writeText('.stride/vault.json', '{"tagColors": ["blue"]}')
    expect(await readTagColors(illegal)).toEqual({})
  })

  it('round-trips colors and preserves other marker fields', async () => {
    const fs = new MemoryFileSystem('tc-round')
    await markDedicatedVault(fs)
    await writeViewMode(fs, 'compact')

    await writeTagColors(fs, { alpha: 'blue', beta: 'gray' })
    expect(await readTagColors(fs)).toEqual({ alpha: 'blue', beta: 'gray' })

    await writeTagColors(fs, { alpha: 'pink' })
    expect(await readTagColors(fs)).toEqual({ alpha: 'pink' })

    const marker = JSON.parse(await fs.readText('.stride/vault.json')) as Record<string, unknown>
    expect(marker.kind).toBe('stride-vault')
    expect(marker.viewMode).toBe('compact')
    expect(marker.tagColors).toEqual({ alpha: 'pink' })
  })

  it('sanitizeTagColors keeps known colors, trims tags, and drops the rest', () => {
    expect(sanitizeTagColors({ alpha: 'BLUE', ' beta ': ' teal ' })).toEqual({ alpha: 'blue', beta: 'teal' })
    // gray is stored as the explicit "auto" marker.
    expect(sanitizeTagColors({ alpha: 'gray' })).toEqual({ alpha: 'gray' })
    expect(sanitizeTagColors({ alpha: 'lime', '': 'blue', beta: 7 })).toEqual({})
    expect(sanitizeTagColors(null)).toEqual({})
    expect(sanitizeTagColors('blue')).toEqual({})
    expect(sanitizeTagColors(undefined)).toEqual({})
  })
})
