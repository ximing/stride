import { isDesktopRuntime } from './runtime'

export async function hostHomeDirectory(): Promise<string> {
  if (isDesktopRuntime()) {
    const { electronHostPaths } = await import('@stride/fs-electron')
    return electronHostPaths().homeDirectory()
  }
  const { browserHostPaths } = await import('@stride/fs-web')
  return browserHostPaths().homeDirectory()
}
