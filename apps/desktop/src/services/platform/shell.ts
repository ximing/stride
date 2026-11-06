import type { ShellBackend } from '@stride/platform'
import { browserShellBackend } from '@stride/shell-web'
import { isDesktopRuntime } from './runtime'

let desktopShell: ShellBackend | null = null

export async function resolveShellBackend(): Promise<ShellBackend> {
  if (isDesktopRuntime()) {
    if (!desktopShell) {
      const { shellBackend } = await import('@stride/shell-tauri')
      desktopShell = shellBackend()
    }
    return desktopShell
  }
  return browserShellBackend()
}
