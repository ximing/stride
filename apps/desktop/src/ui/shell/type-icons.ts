// Type icon model for the rail: `_icon` on a type document is either one of
// the fixed lucide keys below or a free-form emoji (user data, rendered as
// text). Unknown ASCII keys fall back to `note`.
import {
  Bookmark,
  Book,
  Briefcase,
  Calendar,
  Camera,
  Code,
  Coffee,
  Compass,
  FileText,
  Folder,
  Gift,
  Globe,
  Heart,
  Home,
  Leaf,
  Lightbulb,
  Music,
  Pen,
  Rocket,
  Star,
  Tag,
  Target,
  User,
  Wrench,
  type LucideIcon,
} from 'lucide-react'
import type { StrideNote } from '@stride/core/note'

export const TYPE_ICONS: Record<string, LucideIcon> = {
  note: FileText,
  briefcase: Briefcase,
  user: User,
  folder: Folder,
  star: Star,
  tag: Tag,
  calendar: Calendar,
  bookmark: Bookmark,
  heart: Heart,
  home: Home,
  book: Book,
  lightbulb: Lightbulb,
  rocket: Rocket,
  music: Music,
  camera: Camera,
  code: Code,
  globe: Globe,
  coffee: Coffee,
  leaf: Leaf,
  wrench: Wrench,
  target: Target,
  gift: Gift,
  compass: Compass,
  pen: Pen,
}

/** Grid order for the customize picker (24 keys, all present in TYPE_ICONS). */
export const TYPE_ICON_CHOICES: readonly string[] = [
  'note',
  'folder',
  'book',
  'bookmark',
  'star',
  'heart',
  'tag',
  'calendar',
  'user',
  'briefcase',
  'home',
  'globe',
  'lightbulb',
  'rocket',
  'target',
  'compass',
  'code',
  'pen',
  'music',
  'camera',
  'coffee',
  'leaf',
  'wrench',
  'gift',
]

export type TypeIconView = { kind: 'lucide'; key: string } | { kind: 'emoji'; value: string }

function iconRaw(note: StrideNote): string {
  const value = note.properties._icon
  if (typeof value === 'string') return value.trim()
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0].trim()
  return ''
}

/** Non-ASCII `_icon` values are treated as emoji and rendered as text. */
export function isEmojiIcon(raw: string): boolean {
  return raw !== '' && /[^\x00-\x7F]/.test(raw)
}

export function typeIconView(note: StrideNote): TypeIconView {
  const raw = iconRaw(note)
  const key = raw.toLowerCase()
  if (key in TYPE_ICONS) return { kind: 'lucide', key }
  if (isEmojiIcon(raw)) return { kind: 'emoji', value: raw }
  return { kind: 'lucide', key: 'note' }
}
