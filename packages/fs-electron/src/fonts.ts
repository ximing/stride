import { listSystemFonts } from '@stride/electron-api'
import { normalizeSystemFontFamilies, type SystemFontCatalog } from '@stride/platform'

export function electronSystemFonts(): SystemFontCatalog {
  return {
    async listFamilies() {
      const names = await listSystemFonts()
      return normalizeSystemFontFamilies(names)
    },
  }
}
