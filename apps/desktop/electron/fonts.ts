import { normalizeSystemFontFamilies } from '@stride/platform'
import { assertTrustedSender, type RendererTrust, type TrustedSenderEvent } from './security.ts'

export interface FontExecResult {
  stdout: string | Buffer
}

export interface FontExec {
  (file: string, args: readonly string[]): Promise<FontExecResult>
}

export interface FontSender {
  getURL(): string
}

export interface FontIpcEvent {
  sender: FontSender
}

export interface HostFontsDeps {
  handle(channel: string, listener: (event: FontIpcEvent, payload?: unknown) => unknown): void
  getTrust(): RendererTrust
  platform?: NodeJS.Platform
  execFile?: FontExec
}

const WINDOWS_SCRIPT = [
  'Add-Type -AssemblyName System.Drawing;',
  '[System.Drawing.Text.InstalledFontCollection]::new().Families',
  '| ForEach-Object { $_.Name }',
].join(' ')

let cached: readonly string[] | null = null

export function resetHostFontCache(): void {
  cached = null
}

function textOf(stdout: string | Buffer): string {
  return typeof stdout === 'string' ? stdout : stdout.toString('utf8')
}

function familiesFromProfiler(stdout: string): string[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return []
  }
  if (typeof parsed !== 'object' || parsed === null) return []
  const rows = (parsed as { SPFontsDataType?: unknown }).SPFontsDataType
  if (!Array.isArray(rows)) return []
  const names: string[] = []
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue
    const typefaces = (row as { typefaces?: unknown }).typefaces
    if (!Array.isArray(typefaces)) continue
    for (const face of typefaces) {
      if (typeof face !== 'object' || face === null) continue
      const family = (face as { family?: unknown }).family
      if (typeof family === 'string') names.push(family)
    }
  }
  return names
}

function linesOf(stdout: string): string[] {
  const names: string[] = []
  for (const line of stdout.split(/\r?\n/)) {
    for (const part of line.split(',')) {
      const name = part.trim()
      if (name) names.push(name)
    }
  }
  return names
}

async function rawFamilies(platform: NodeJS.Platform, execFile: FontExec): Promise<string[]> {
  if (platform === 'darwin') {
    const result = await execFile('system_profiler', ['SPFontsDataType', '-json'])
    return familiesFromProfiler(textOf(result.stdout))
  }
  if (platform === 'win32') {
    const result = await execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_SCRIPT])
    return linesOf(textOf(result.stdout))
  }
  if (platform === 'linux') {
    const result = await execFile('fc-list', ['-f', '%{family}\\n'])
    return linesOf(textOf(result.stdout))
  }
  return []
}

/** Trim, drop private or unsafe names, sort, and dedupe. Failures become an empty list. */
export async function collectFontFamilies(platform: NodeJS.Platform, execFile: FontExec): Promise<readonly string[]> {
  try {
    return normalizeSystemFontFamilies(await rawFamilies(platform, execFile))
  } catch {
    return []
  }
}

async function cachedFamilies(platform: NodeJS.Platform, execFile: FontExec): Promise<readonly string[]> {
  if (cached) return cached
  const names = await collectFontFamilies(platform, execFile)
  cached = names
  return names
}

/** Register `host:fonts`. The handler checks the sender first and caches the normalized list. */
export function registerHostFonts(deps: HostFontsDeps): void {
  const platform = deps.platform ?? process.platform
  const execFile = deps.execFile ?? defaultExec

  deps.handle('host:fonts', async (event) => {
    assertTrustedSender(event as TrustedSenderEvent, deps.getTrust())
    return cachedFamilies(platform, execFile)
  })
}

async function defaultExec(file: string, args: readonly string[]): Promise<FontExecResult> {
  const { execFile } = await import('node:child_process')
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 60_000, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
      if (error) reject(error)
      else resolve({ stdout })
    })
  })
}
