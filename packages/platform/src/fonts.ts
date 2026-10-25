export interface SystemFontCatalog {
  /** Installed font family names, sorted and safe to drop into a CSS font-family. */
  listFamilies(): Promise<readonly string[]>
}

const FONT_FAMILY_MAX = 128

/**
 * A single installed family name. Rejects private faces (leading `.` or `@`)
 * and characters that would break out of a quoted CSS font-family value.
 * Empty means "not a listable family".
 */
export function isListableFontFamily(name: string): boolean {
  if (!name || name.length > FONT_FAMILY_MAX) return false
  if (name.startsWith('.') || name.startsWith('@')) return false
  return !/[\u0000-\u001f\u007f\\{}<>"'`;,:]/.test(name)
}

/** Trim, drop unsafe or duplicate names, and sort for a stable picker. */
export function normalizeSystemFontFamilies(names: readonly string[]): string[] {
  const seen = new Set<string>()
  const unique: string[] = []
  for (const raw of names) {
    if (typeof raw !== 'string') continue
    const name = raw.trim()
    if (!isListableFontFamily(name)) continue
    const key = name.toLocaleLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(name)
  }
  unique.sort((left, right) => left.localeCompare(right, undefined, { sensitivity: 'base', numeric: true }))
  return unique
}

export function memorySystemFonts(families: readonly string[]): SystemFontCatalog {
  return {
    listFamilies() {
      return Promise.resolve(normalizeSystemFontFamilies(families))
    },
  }
}
