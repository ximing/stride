import { normalizeSystemFontFamilies, type SystemFontCatalog } from '@stride/platform'

type LocalFontFace = { family?: string }

export interface BrowserFontSource {
  queryLocalFonts?: () => Promise<readonly LocalFontFace[]>
  /** True when `family` is installed. Used when the host cannot enumerate fonts. */
  measure?: (family: string) => boolean
}

// Families probed only when the host has no font enumeration API. The desktop
// shell lists the real set through Core Text / fontconfig; this covers browsers.
const PROBE_FAMILIES = [
  'Avenir Next',
  'Avenir',
  'Georgia',
  'Helvetica Neue',
  'Helvetica',
  'Iowan Old Style',
  'Palatino',
  'Times New Roman',
  'Arial',
  'Segoe UI',
  'Calibri',
  'Cambria',
  'PingFang SC',
  'PingFang TC',
  'PingFang HK',
  'Hiragino Sans GB',
  'Hiragino Sans',
  'Songti SC',
  'Songti TC',
  'Kaiti SC',
  'Heiti SC',
  'STSong',
  'STHeiti',
  'Yuanti SC',
  'Source Han Sans SC',
  'Source Han Serif SC',
  'Noto Sans CJK SC',
  'Noto Serif CJK SC',
  'Noto Sans SC',
  'Noto Serif SC',
  'Microsoft YaHei',
  'SimSun',
  'SimHei',
  'KaiTi',
  'FangSong',
  'Sarasa Gothic SC',
  'LXGW WenKai',
] as const

function readNavigatorQuery(): BrowserFontSource['queryLocalFonts'] {
  const nav = navigator as Navigator & { queryLocalFonts?: BrowserFontSource['queryLocalFonts'] }
  return typeof nav.queryLocalFonts === 'function' ? nav.queryLocalFonts.bind(nav) : undefined
}

function canvasFontMeasurer(): (family: string) => boolean {
  if (typeof document === 'undefined') return () => false
  const canvas = document.createElement('canvas')
  const context = canvas.getContext('2d')
  if (!context) return () => false
  const sample = 'mmmmmmmmmmlliWW'
  const bases = ['monospace', 'sans-serif', 'serif'] as const
  const baseWidths = bases.map((base) => {
    context.font = `72px ${base}`
    return context.measureText(sample).width
  })
  return (family) => bases.some((base, index) => {
    const baseWidth = baseWidths[index] ?? 0
    if (baseWidth <= 0) return false
    context.font = `72px ${JSON.stringify(family)}, ${base}`
    const width = context.measureText(sample).width
    return width > 0 && Math.abs(width - baseWidth) > 0.5
  })
}

export async function collectBrowserFontFamilies(source: BrowserFontSource = {}): Promise<string[]> {
  const query = source.queryLocalFonts ?? readNavigatorQuery()
  if (query) {
    try {
      const faces = await query()
      const names = normalizeSystemFontFamilies(faces.map((face) => face.family ?? ''))
      if (names.length > 0) return names
    } catch {
      // Permission denied, or the call was not made from a user gesture.
    }
  }
  const measure = source.measure ?? canvasFontMeasurer()
  return normalizeSystemFontFamilies(PROBE_FAMILIES.filter((family) => measure(family)))
}

export function browserSystemFonts(): SystemFontCatalog {
  return {
    listFamilies: () => collectBrowserFontFamilies(),
  }
}
