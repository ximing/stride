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
  const text = (Array.isArray(raw) ? raw[0] ?? '' : raw ?? '').trim()
  return text || note.title
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
