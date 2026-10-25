import { isDesktopRuntime } from './runtime'

/** Installed font families. Desktop asks the shell; the browser uses the local font API. */
export async function listSystemFontFamilies(): Promise<readonly string[]> {
  if (isDesktopRuntime()) {
    const { tauriSystemFonts } = await import('@stride/fs-tauri')
    return tauriSystemFonts().listFamilies()
  }
  const { browserSystemFonts } = await import('@stride/fs-web')
  return browserSystemFonts().listFamilies()
}
