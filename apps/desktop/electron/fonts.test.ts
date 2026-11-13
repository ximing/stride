// @vitest-environment node
import { execFile as execFileCallback } from 'node:child_process'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { collectFontFamilies, registerHostFonts, resetHostFontCache, type FontExec, type FontIpcEvent } from './fonts.ts'
import type { RendererTrust } from './security.ts'

const DEV = 'http://127.0.0.1:1421/'
const trust: RendererTrust = { packaged: false, devUrl: DEV }

function exec(file: string, args: readonly string[]): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    execFileCallback(file, [...args], { timeout: 60_000, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' }, (error, stdout) => {
      if (error) reject(error)
      else resolve({ stdout })
    })
  })
}

describe('font family normalization', () => {
  it('drops private names and keeps one casing', async () => {
    const execFile = vi.fn<FontExec>(async () => ({
      stdout: '.LastResort\n Songti SC \ngeorgia\nGeorgia\n  \n@Vertical\nBad;Font\n',
    }))
    await expect(collectFontFamilies('linux', execFile)).resolves.toEqual(['georgia', 'Songti SC'])
    expect(execFile).toHaveBeenCalledWith('fc-list', ['-f', '%{family}\\n'])
  })

  it('splits comma-separated fontconfig families', async () => {
    const execFile = vi.fn<FontExec>(async () => ({ stdout: 'Noto Sans, Noto Sans CJK\n' }))
    await expect(collectFontFamilies('linux', execFile)).resolves.toEqual(['Noto Sans', 'Noto Sans CJK'])
  })

  it('returns an empty list when the command fails', async () => {
    const execFile = vi.fn<FontExec>(async () => {
      throw new Error('fc-list missing')
    })
    await expect(collectFontFamilies('linux', execFile)).resolves.toEqual([])
  })

  it('reads nested typeface families from system_profiler JSON', async () => {
    const execFile = vi.fn<FontExec>(async () => ({
      stdout: JSON.stringify({
        SPFontsDataType: [
          { typefaces: [{ family: 'Times New Roman' }, { family: '.LastResort' }] },
          { typefaces: [{ family: 'Times New Roman' }, { family: 'Helvetica' }] },
        ],
      }),
    }))
    await expect(collectFontFamilies('darwin', execFile)).resolves.toEqual(['Helvetica', 'Times New Roman'])
    expect(execFile).toHaveBeenCalledWith('system_profiler', ['SPFontsDataType', '-json'])
  })

  it('asks PowerShell for GDI families on Windows', async () => {
    const execFile = vi.fn<FontExec>(async () => ({ stdout: 'Segoe UI\n' }))
    await expect(collectFontFamilies('win32', execFile)).resolves.toEqual(['Segoe UI'])
    expect(execFile.mock.calls[0]?.[0]).toBe('powershell.exe')
    expect(execFile.mock.calls[0]?.[1]?.join(' ')).toContain('InstalledFontCollection')
  })

  it('returns nothing on an unknown platform', async () => {
    const execFile = vi.fn<FontExec>()
    await expect(collectFontFamilies('aix', execFile)).resolves.toEqual([])
    expect(execFile).not.toHaveBeenCalled()
  })
})

describe('host:fonts', () => {
  let handlers: Map<string, (event: FontIpcEvent) => unknown>

  beforeEach(() => {
    resetHostFontCache()
    handlers = new Map()
  })

  function register(execFile: FontExec, platform: NodeJS.Platform = 'linux') {
    registerHostFonts({
      handle(channel, listener) {
        handlers.set(channel, listener)
      },
      getTrust: () => trust,
      platform,
      execFile,
    })
  }

  it('caches a successful list and rejects an untrusted sender', async () => {
    const execFile = vi.fn<FontExec>(async () => ({ stdout: 'Georgia\nHelvetica\n' }))
    register(execFile)
    const handler = handlers.get('host:fonts')
    if (!handler) throw new Error('missing host:fonts')
    const event = { sender: { getURL: () => DEV } }
    await expect(handler(event)).resolves.toEqual(['Georgia', 'Helvetica'])
    await expect(handler(event)).resolves.toEqual(['Georgia', 'Helvetica'])
    expect(execFile).toHaveBeenCalledTimes(1)
    await expect(handler({ sender: { getURL: () => 'https://evil.example/' } })).rejects.toThrow(/untrusted/i)
  })

  it('caches an empty list after a failure', async () => {
    const execFile = vi.fn<FontExec>(async () => {
      throw new Error('no fonts')
    })
    register(execFile)
    const handler = handlers.get('host:fonts')
    if (!handler) throw new Error('missing host:fonts')
    const event = { sender: { getURL: () => DEV } }
    await expect(handler(event)).resolves.toEqual([])
    await expect(handler(event)).resolves.toEqual([])
    expect(execFile).toHaveBeenCalledTimes(1)
  })
})

describe('installed fonts on this machine', () => {
  beforeEach(() => {
    resetHostFontCache()
  })

  it('lists at least one family on macOS', async () => {
    if (process.platform !== 'darwin') return
    const names = await collectFontFamilies('darwin', exec)
    expect(names.length).toBeGreaterThan(0)
    const lowered = names.map((name) => name.toLowerCase())
    const sorted = [...lowered].sort((left, right) => left.localeCompare(right, undefined, { sensitivity: 'base', numeric: true }))
    expect(lowered).toEqual(sorted)
    expect(new Set(lowered).size).toBe(lowered.length)
    expect(names.every((name) => name.trim() === name && !name.startsWith('.') && !name.startsWith('@'))).toBe(true)
  }, 60_000)
})
