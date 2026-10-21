import type { LucideIcon } from 'lucide-react'

export function Mark({ icon: Glyph, size = 18 }: { icon: LucideIcon; size?: number }) {
  return <Glyph aria-hidden="true" focusable="false" size={size} strokeWidth={1.75} />
}
