import { DATE_VALUE, propertyKind, type NoteProperty, type StrideNote } from '@stride/core/note'

/**
 * Semantic editor kind for a property row: the generic storage kind refined
 * by well-known names and value shapes. Storage on disk never changes — this
 * only decides which control the panel renders.
 */
export type FieldKind = 'boolean' | 'number' | 'list' | 'text' | 'status' | 'date' | 'tags' | 'links'

export { DATE_VALUE }
const WIKILINK_ITEM = /^\[\[[^\]]+\]\]$/

export function fieldKindOf(name: string, value: NoteProperty | undefined): FieldKind {
  const kind = propertyKind(value)
  if (kind === 'boolean' || kind === 'number') return kind
  const key = name.trim().toLowerCase()
  if (kind === 'list') {
    if (key === 'tags') return 'tags'
    if (key === 'links') return 'links'
    const items = Array.isArray(value) ? value : []
    if (items.length > 0 && items.every((item) => WIKILINK_ITEM.test(item))) return 'links'
    return 'list'
  }
  if (key === 'status') return 'status'
  const text = typeof value === 'string' ? value.trim() : ''
  if (DATE_VALUE.test(text)) return 'date'
  if (key === 'date' && text === '') return 'date'
  return 'text'
}

export type StatusTone = 'draft' | 'doing' | 'done' | 'muted'

/** Lowercased status label → tone. Mirrors the note-list chip mapping so the
 * properties panel can tint statuses without importing list code. */
const STATUS_TONES: Record<string, StatusTone> = {
  draft: 'draft',
  草稿: 'draft',
  todo: 'doing',
  doing: 'doing',
  'in progress': 'doing',
  待办: 'doing',
  进行中: 'doing',
  done: 'done',
  published: 'done',
  完成: 'done',
  已完成: 'done',
  已发布: 'done',
}

export function statusTone(status: string): StatusTone {
  return STATUS_TONES[status.trim().toLowerCase()] ?? 'muted'
}

/** Dot color per tone, as design-token references for combobox options. */
export const STATUS_TONE_DOT: Record<StatusTone, string> = {
  draft: 'var(--sd-warning)',
  doing: 'var(--sd-dot-blue)',
  done: 'var(--sd-accent)',
  muted: 'var(--sd-muted)',
}

/** Every tag in the vault, deduped and sorted. Accepts both the list form and
 * the comma-separated string form. */
export function collectTags(notes: readonly StrideNote[]): string[] {
  const tags = new Set<string>()
  for (const note of notes) {
    const raw = note.properties.tags
    const items = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[,，]/) : []
    for (const item of items) {
      const tag = item.trim()
      if (tag !== '') tags.add(tag)
    }
  }
  return [...tags].sort((a, b) => a.localeCompare(b))
}

/** Every status value used in the vault, deduped and sorted. */
export function collectStatusValues(notes: readonly StrideNote[]): string[] {
  const values = new Set<string>()
  for (const note of notes) {
    const raw = note.properties.status
    const items = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : []
    for (const item of items) {
      const value = item.trim()
      if (value !== '') values.add(value)
    }
  }
  return [...values].sort((a, b) => a.localeCompare(b))
}
