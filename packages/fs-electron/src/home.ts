import { homeDir } from '@stride/electron-api'
import { PlatformError, type HostPaths } from '@stride/platform'

export function electronHostPaths(): HostPaths {
  return {
    async homeDirectory() {
      const home = await homeDir()
      if (!home) throw new PlatformError('io', 'Could not resolve the home directory')
      return home
    },
  }
}
