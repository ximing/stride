import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

describe('desktop window frame boot', () => {
  const html = readFileSync(resolve(desktop, 'index.html'), 'utf8')
  const tokens = readFileSync(resolve(desktop, 'src/ui/tokens.css'), 'utf8')
  const frame = readFileSync(resolve(desktop, 'src-tauri/src/frame.rs'), 'utf8')

  it('marks the Tauri document before the app bundle', () => {
    const boot = html.indexOf('__TAURI_INTERNALS__')
    const module = html.indexOf('type="module"')
    expect(boot).toBeGreaterThan(-1)
    expect(module).toBeGreaterThan(boot)
    expect(html).toContain("setAttribute('data-desktop', 'tauri')")
    expect(html).toContain("localStorage.getItem('stride:theme')")
  })

  it('uses the same plate colors and radius as the tokens and the native clip', () => {
    expect(tokens).toContain('--sd-bg: #ebede6;')
    expect(tokens).toContain('--sd-border: #d9ddd3;')
    expect(tokens).toContain('--sd-bg: #171a18;')
    expect(tokens).toContain('--sd-border: #353c36;')
    expect(tokens).toContain('--sd-radius-lg: 12px;')
    expect(html).toContain('#ebede6')
    expect(html).toContain('#d9ddd3')
    expect(html).toContain('#171a18')
    expect(html).toContain('#353c36')
    expect(html).toContain('border-radius: 12px')
    expect(frame).toContain('pub const RADIUS_PX: f64 = 12.0;')
  })
})
