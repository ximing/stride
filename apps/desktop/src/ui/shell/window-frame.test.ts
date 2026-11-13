import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

describe('desktop window frame boot', () => {
  const html = readFileSync(resolve(desktop, 'index.html'), 'utf8')
  const tokens = readFileSync(resolve(desktop, 'src/ui/tokens.css'), 'utf8')
  const windows = readFileSync(resolve(desktop, 'electron/windows.ts'), 'utf8')
  const controls = readFileSync(resolve(desktop, 'src/ui/shell/window-controls.css'), 'utf8')

  it('marks the desktop document before the app bundle', () => {
    const boot = html.indexOf('__STRIDE_ELECTRON__')
    const module = html.indexOf('type="module"')
    expect(boot).toBeGreaterThan(-1)
    expect(module).toBeGreaterThan(boot)
    expect(html).toContain("setAttribute('data-desktop', 'electron')")
    expect(html).toContain("localStorage.getItem('stride:theme')")
    expect(html).toContain("html[data-desktop='electron'][data-window-fill] #root")
    expect(html).toContain('border-radius: 0')
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
    expect(windows).toContain('frame: false')
    expect(windows).toContain('transparent: true')
  })

  it('makes the rail drag strip draggable and keeps controls out of it', () => {
    expect(controls).toMatch(/\.rail-drag\s*\{[^}]*-webkit-app-region:\s*drag/)
    expect(controls).toMatch(/button[\s\S]*-webkit-app-region:\s*no-drag/)
    expect(controls).toMatch(/\.window-controls[\s\S]*-webkit-app-region:\s*no-drag/)
  })
})
