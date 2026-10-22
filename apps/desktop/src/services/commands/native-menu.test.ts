import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import manifest from '../../appCommandManifest.json'
import { DESKTOP_DISABLED_SHORTCUTS } from './command.service'
import { parseAppCommandManifest } from './commands'

const MENU_RS = join(__dirname, '../../../src-tauri/src/menu.rs')

/** webview must not dispatch these on desktop — native File menu owns the chords. */
const DESKTOP_WEBVIEW_DISABLED = ['tab.close', 'file.newWindow', 'file.openProject'] as const

/** Native File menu accelerators. Close Window has no manifest command. */
const NATIVE_MENU_ACCELS = [
  { rustConst: 'ACCEL_NEW_WINDOW', rustChord: 'CmdOrCtrl+Shift+N', commandId: 'file.newWindow', manifest: 'Mod+Shift+N' },
  { rustConst: 'ACCEL_OPEN_PROJECT', rustChord: 'CmdOrCtrl+O', commandId: 'file.openProject', manifest: 'Mod+O' },
  { rustConst: 'ACCEL_CLOSE_WINDOW', rustChord: 'CmdOrCtrl+Shift+W', commandId: null },
] as const

describe('native File menu accelerators', () => {
  const rust = readFileSync(MENU_RS, 'utf8')
  const commands = parseAppCommandManifest(manifest)

  it('keeps DESKTOP_DISABLED_SHORTCUTS aligned with the native File menu set', () => {
    expect([...DESKTOP_DISABLED_SHORTCUTS].sort()).toEqual([...DESKTOP_WEBVIEW_DISABLED].sort())
  })

  it('matches menu.rs ACCEL_* constants and the corresponding manifest shortcuts', () => {
    for (const row of NATIVE_MENU_ACCELS) {
      const pattern = new RegExp(`const ${row.rustConst}: &str = "${row.rustChord.replaceAll('+', '\\+')}";`)
      expect(pattern.test(rust), `${row.rustConst} missing or drifted in menu.rs`).toBe(true)
      if (!row.commandId) continue
      const command = commands.find((item) => item.id === row.commandId)
      expect(command, row.commandId).toBeTruthy()
      expect(command?.shortcut, row.commandId).toBe(row.manifest)
    }
  })
})
