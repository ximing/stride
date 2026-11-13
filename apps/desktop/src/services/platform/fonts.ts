import { isDesktopRuntime } from './runtime'

/** Installed font families. Desktop asks the shell; the browser uses the local font API. */
export async function listSystemFontFamilies(): Promise<readonly string[]> {
  if (isDesktopRuntime()) {
    const { electronSystemFonts } = await import('@stride/fs-electron')
    return electronSystemFonts().listFamilies()
  }
  const { browserSystemFonts } = await import('@stride/fs-web')
  return browserSystemFonts().listFamilies()
}
