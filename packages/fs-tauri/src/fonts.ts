import { normalizeSystemFontFamilies, type SystemFontCatalog } from '@stride/platform'

export function tauriSystemFonts(): SystemFontCatalog {
  return {
    async listFamilies() {
      const { invoke } = await import('@tauri-apps/api/core')
      const names = await invoke<unknown>('list_font_families')
      return normalizeSystemFontFamilies(Array.isArray(names) ? names.filter((name): name is string => typeof name === 'string') : [])
    },
  }
}
