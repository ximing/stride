import type { HostPaths } from '@stride/platform'

// NUL cannot occur in a directory name or an absolute path the user can pick.
export const BROWSER_HOME_SENTINEL = '\0stride-browser-home'

export function browserHostPaths(): HostPaths {
  return {
    homeDirectory() {
      return Promise.resolve(BROWSER_HOME_SENTINEL)
    },
  }
}
