import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isDesktopRuntime, isMemoryFixture } from './runtime'

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
  it('detects only the Electron bridge', () => {
    const win = window as unknown as Record<string, unknown>
    delete win.__STRIDE_ELECTRON__
    win.__STRIDE_OTHER__ = {}
    expect(isDesktopRuntime()).toBe(false)
    delete win.__STRIDE_OTHER__
    win.__STRIDE_ELECTRON__ = {
      invoke: () => Promise.resolve(undefined),
      on: () => () => {},
    }
    expect(isDesktopRuntime()).toBe(true)
    delete win.__STRIDE_ELECTRON__
    expect(isDesktopRuntime()).toBe(false)
  })

  it('treats a missing window as not a memory fixture', () => {
    expect(isMemoryFixture()).toBe(false)
  })

  it('keeps the Electron bridge literal only in runtime.ts', () => {
    const hits: string[] = []
    for (const file of walkSource(SRC_ROOT)) {
      const text = readFileSync(file, 'utf8')
      if (!text.includes("'__STRIDE_ELECTRON__'") && !text.includes('"__STRIDE_ELECTRON__"')) continue
      hits.push(relative(SRC_ROOT, file).replaceAll('\\', '/'))
    }
    expect(hits).toEqual(['services/platform/runtime.ts'])
  })
})

describe('core package surface', () => {
  it('does not let production code reach into packages/core/src', () => {
    const hits: string[] = []
    for (const file of walkSource(SRC_ROOT)) {
      const text = readFileSync(file, 'utf8')
      if (!text.includes('packages/core/src')) continue
      hits.push(relative(SRC_ROOT, file).replaceAll('\\', '/'))
    }
    expect(hits).toEqual([])
  })
})
