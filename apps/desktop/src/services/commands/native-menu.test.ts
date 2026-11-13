import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import manifest from '../../appCommandManifest.json'
import { DESKTOP_DISABLED_SHORTCUTS } from './command.service'
import { parseAppCommandManifest } from './commands'

const MENU_MODEL = join(__dirname, '../../../electron/menu-model.ts')

/** Renderer must not dispatch these on desktop — the native File menu owns them. */
const DESKTOP_WEBVIEW_DISABLED = ['tab.close', 'file.newWindow', 'file.openProject'] as const

describe('native File menu accelerators', () => {
  const model = readFileSync(MENU_MODEL, 'utf8')
  const commands = parseAppCommandManifest(manifest)

  it('keeps DESKTOP_DISABLED_SHORTCUTS aligned with the native File menu set', () => {
    expect([...DESKTOP_DISABLED_SHORTCUTS].sort()).toEqual([...DESKTOP_WEBVIEW_DISABLED].sort())
  })

  it('keeps Electron File menu accelerators and the manifest shortcuts', () => {
    expect(model).toContain("accelerator: 'CmdOrCtrl+N'")
    expect(model).toContain("accelerator: 'CmdOrCtrl+O'")
    expect(model).toContain("accelerator: 'CmdOrCtrl+W'")
    expect(commands.find((item) => item.id === 'file.newWindow')?.shortcut).toBe('Mod+Shift+N')
    expect(commands.find((item) => item.id === 'file.openProject')?.shortcut).toBe('Mod+O')
  })
})
