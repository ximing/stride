import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isDesktopRuntime, isMemoryFixture, isTauriRuntime } from './runtime'

const SRC_ROOT = join(__dirname, '../..')

function walkSource(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      if (name === 'e2e') continue
      walkSource(full, out)
      continue
    }
    if (/\.(test|spec)\.(ts|tsx)$/.test(name)) continue
    if (/\.(ts|tsx)$/.test(name)) out.push(full)
  }
  return out
}

describe('runtime probes', () => {
  it('aliases isTauriRuntime to isDesktopRuntime', () => {
    expect(isTauriRuntime).toBe(isDesktopRuntime)
  })

  it('treats a missing window as not a memory fixture', () => {
    expect(isMemoryFixture()).toBe(false)
  })

  it('keeps the Tauri internals literal only in runtime.ts', () => {
    const hits: string[] = []
    for (const file of walkSource(SRC_ROOT)) {
      const text = readFileSync(file, 'utf8')
      if (!text.includes("'__TAURI_INTERNALS__'") && !text.includes('"__TAURI_INTERNALS__"')) continue
      hits.push(relative(SRC_ROOT, file).replaceAll('\\', '/'))
    }
    expect(hits).toEqual(['services/platform/runtime.ts'])
  })
})
