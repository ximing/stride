import { unavailableShell, type ShellBackend } from '@stride/platform'

export function browserShellBackend(): ShellBackend {
  return unavailableShell()
}
