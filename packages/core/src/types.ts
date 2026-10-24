import type { NoteProperty, StrideNote, TipTapNode } from './note.ts'

function isHiddenValue(value: unknown): boolean {
  if (value === false) return true
  if (typeof value === 'string') return value.trim() === 'false'
  if (Array.isArray(value)) return isHiddenValue(value[0])
  return false
}

export function isTypeVisible(note: StrideNote): boolean {
  return !isHiddenValue(note.properties.visible)
}

export function typeSortOrder(note: StrideNote): number {
  const raw = note.properties._order
  const text = Array.isArray(raw) ? raw[0] ?? '' : raw ?? ''
  const value = Number(text)
  return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY
}

export function compareTypeDocuments(a: StrideNote, b: StrideNote): number {
  return typeSortOrder(a) - typeSortOrder(b) || a.title.localeCompare(b.title)
}

export function typeSidebarLabel(note: StrideNote): string {
  const raw = note.properties._sidebar_label
  const picked = Array.isArray(raw) ? raw[0] ?? '' : raw ?? ''
  const text = typeof picked === 'string' ? picked.trim() : String(picked).trim()
  return text || note.title
}

/** The nine type colors with matching `--sd-dot-*` tokens in the desktop UI. */
export const TYPE_COLOR_KEYS = ['gray', 'blue', 'teal', 'green', 'orange', 'purple', 'red', 'pink', 'yellow'] as const
export type TypeColor = (typeof TYPE_COLOR_KEYS)[number]

// Hash fallback palette: gray means "auto" (see resolveTypeColor), so the
// hashed result always comes from the eight real colors.
const HASH_FALLBACK_COLORS: readonly TypeColor[] = ['blue', 'teal', 'green', 'orange', 'purple', 'red', 'pink', 'yellow']

/** djb2 over the lowercased name, kept as an unsigned 32-bit integer. */
function hashEntityName(name: string): number {
  const normalized = name.trim().toLowerCase()
  let hash = 5381
  for (let index = 0; index < normalized.length; index++) {
    hash = ((hash << 5) + hash + normalized.charCodeAt(index)) >>> 0
  }
  return hash
}

/**
 * Resolve the display color of a named entity (type, tag, …). An explicit
 * color of one of the eight real colors always wins. `gray` means "auto" —
 * it is the default written by createType rather than a user choice — so
 * gray, a missing value, or an unknown value all fall back to hashing the
 * name deterministically into the eight non-gray colors. Every surface
 * (sidebar, list chips) therefore shows the same color for the same name,
 * and gray never comes out of the hash.
 */
export function resolveEntityColor(name: string, explicitColor?: string): TypeColor {
  const key = (explicitColor ?? '').trim().toLowerCase()
  if (key !== 'gray' && (TYPE_COLOR_KEYS as readonly string[]).includes(key)) return key as TypeColor
  return HASH_FALLBACK_COLORS[hashEntityName(name) % HASH_FALLBACK_COLORS.length]
}

/** Resolve a type's display color. Thin wrapper over resolveEntityColor. */
export function resolveTypeColor(title: string, explicitColor?: string): TypeColor {
  return resolveEntityColor(title, explicitColor)
}

/** Resolve a type document's color from its `_color` property and title. */
export function typeColorKey(note: StrideNote): TypeColor {
  const raw = note.properties._color
  const picked = Array.isArray(raw) ? raw[0] ?? '' : raw ?? ''
  const text = typeof picked === 'string' ? picked : String(picked)
  return resolveTypeColor(note.title, text)
}

export function nextTypeOrder(notes: StrideNote[]): string {
  let max = Number.NEGATIVE_INFINITY
  for (const note of notes) {
    if (note.type !== 'Type') continue
    const order = typeSortOrder(note)
    if (!Number.isFinite(order) || order <= max) continue
    max = order
  }
  if (!Number.isFinite(max)) return '1'
  return String(max + 1)
}

export function templateBody(template: NoteProperty | undefined): TipTapNode | null {
  if (typeof template !== 'string' || template.trim() === '') return null
  return {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: template }] }],
  }
}
