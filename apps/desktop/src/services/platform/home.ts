import { isDesktopRuntime } from './runtime'

export async function hostHomeDirectory(): Promise<string> {
  if (isDesktopRuntime()) {
    const { tauriHostPaths } = await import('@stride/fs-tauri')
    return tauriHostPaths().homeDirectory()
  }
  const { browserHostPaths } = await import('@stride/fs-web')
  return browserHostPaths().homeDirectory()
}
