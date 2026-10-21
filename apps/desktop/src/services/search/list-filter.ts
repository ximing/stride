import { isHiddenProperty, type NoteProperty, type StrideNote } from '@stride/core/note'

function propertyIncludes(value: NoteProperty, needle: string): boolean {
  if (typeof value === 'string') return value.toLowerCase().includes(needle)
  if (typeof value === 'number') return String(value).toLowerCase().includes(needle)
  if (typeof value === 'boolean') return (value ? 'true' : 'false').includes(needle)
  return value.some((item) => item.toLowerCase().includes(needle))
}

/** Case-insensitive substring on title or non-`_` property values. Empty query keeps the list. */
export function filterNotes(notes: readonly StrideNote[], query: string): readonly StrideNote[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return notes
  return notes.filter((note) => {
    if (note.title.toLowerCase().includes(needle)) return true
    const properties = note.properties ?? {}
    for (const [key, value] of Object.entries(properties)) {
      if (isHiddenProperty(key)) continue
      if (propertyIncludes(value, needle)) return true
    }
    return false
  })
}
