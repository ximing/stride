import type { Icon } from '@phosphor-icons/react'

export function Mark({ icon: Glyph, size = 18 }: { icon: Icon; size?: number }) {
  return <Glyph aria-hidden size={size} weight="regular" />
}
