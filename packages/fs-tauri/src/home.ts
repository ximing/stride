import { PlatformError, type HostPaths } from '@stride/platform'

export function tauriHostPaths(): HostPaths {
  return {
    async homeDirectory() {
      const { homeDir } = await import('@tauri-apps/api/path')
      const home = await homeDir()
      if (!home) throw new PlatformError('io', 'Could not resolve the home directory')
      return home
    },
  }
}
