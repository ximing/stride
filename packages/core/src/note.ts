export const NOTE_EXT = '.stride.json'
export const NOTE_FORMAT = 'tiptap'

export interface TipTapMark {
  type: string
  attrs?: Record<string, unknown>
}

export interface TipTapNode {
  type: string
  attrs?: Record<string, unknown>
  text?: string
  marks?: TipTapMark[]
  content?: TipTapNode[]
}

export type NoteProperty = string | number | boolean | string[]

export type PropertyKind = 'string' | 'number' | 'boolean' | 'list'

export interface StrideNote {
  id: string
  title: string
  type: string
  properties: Record<string, NoteProperty>
  doc: TipTapNode
}

export interface NoteFile {
  format: typeof NOTE_FORMAT
  title: string
  type: string
  properties: Record<string, NoteProperty>
  doc: TipTapNode
}

export function emptyDoc(_title: string): TipTapNode {
  return {
    type: 'doc',
    content: [{ type: 'paragraph' }],
  }
}

export function createNote(id: string, title: string, type = 'note'): StrideNote {
  return {
    id,
    title,
    type,
    properties: {},
    doc: emptyDoc(title),
  }
}

export function serializeNote(note: StrideNote): string {
  const file: NoteFile = {
    format: NOTE_FORMAT,
    title: note.title,
    type: note.type || 'note',
    properties: note.properties,
    doc: note.doc,
  }
  return `${JSON.stringify(file, null, 2)}\n`
}

export function parseNote(raw: string, id: string): StrideNote {
  const trimmed = raw.trim()
  if (trimmed.startsWith('---')) {
    throw new Error(`Refusing to open ${id}: notes are TipTap JSON, not Markdown frontmatter`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    throw new Error(`Note ${id} is not TipTap JSON`)
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Note ${id} is not a TipTap document`)
  }
  const file = parsed as Partial<NoteFile>
  if (file.format !== NOTE_FORMAT || !file.doc || file.doc.type !== 'doc') {
    throw new Error(`Note ${id} is not a TipTap document`)
  }
  const storedTitle = typeof file.title === 'string' && file.title.trim() ? file.title : ''
  const leading = leadingH1Text(file.doc)
  return {
    id,
    title: leading || storedTitle || id,
    type: typeof file.type === 'string' && file.type.trim() ? file.type : 'note',
    properties: sanitizeProperties(file.properties),
    doc: file.doc,
  }
}

export function plainText(doc: TipTapNode): string {
  const parts: string[] = []
  const walk = (current: TipTapNode | undefined) => {
    if (!current) return
    if (current.type === 'text' && current.text) parts.push(current.text)
    if (current.type === 'wikilink') {
      const target = current.attrs?.target
      if (typeof target === 'string' && target) parts.push(target)
    }
    current.content?.forEach(walk)
  }
  walk(doc)
  return parts.join(' ').replace(/\s+/g, ' ').trim()
}

export function findMark(doc: TipTapNode, mark: string): { text: string } | undefined {
  let found: { text: string } | undefined
  const walk = (current: TipTapNode | undefined) => {
    if (!current || found) return
    if (current.marks?.some((item) => item.type === mark) && current.text) {
      found = { text: current.text }
      return
    }
    current.content?.forEach(walk)
  }
  walk(doc)
  return found
}

export function headingText(doc: TipTapNode): string {
  let text = ''
  const walk = (current: TipTapNode | undefined) => {
    if (!current || text) return
    if (current.type === 'heading') {
      text = plainText(current)
      return
    }
    current.content?.forEach(walk)
  }
  walk(doc)
  return text
}

export function isPlaceholderTitle(title: string): boolean {
  const trimmed = title.trim()
  return trimmed === '' || trimmed.toLowerCase() === 'untitled'
}

function isH1(node: TipTapNode | undefined): boolean {
  return !!node && node.type === 'heading' && node.attrs?.level === 1
}

function leadingH1Text(doc: TipTapNode): string {
  const first = doc.content?.[0]
  if (!isH1(first)) return ''
  return plainText(first)
}

export function firstH1Text(doc: TipTapNode): string {
  let text = ''
  const walk = (current: TipTapNode | undefined) => {
    if (!current || text) return
    if (current.type === 'heading' && current.attrs?.level === 1) {
      text = plainText(current)
      return
    }
    current.content?.forEach(walk)
  }
  walk(doc)
  return text
}

function titleHeading(text: string): TipTapNode {
  if (!text) return { type: 'heading', attrs: { level: 1 } }
  return { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text }] }
}

export function stripLeadingH1(doc: TipTapNode): TipTapNode {
  const content = doc.content ?? []
  if (!isH1(content[0])) return doc
  const rest = content.slice(1)
  return { type: 'doc', content: rest.length > 0 ? rest : [{ type: 'paragraph' }] }
}

export function composeNoteDoc(title: string, body: TipTapNode): TipTapNode {
  const content = body.content ? [...body.content] : []
  if (isPlaceholderTitle(title)) {
    return { type: 'doc', content: content.length > 0 ? content : [{ type: 'paragraph' }] }
  }
  if (isH1(content[0]) && plainText(content[0]!) === title) return { type: 'doc', content }
  return { type: 'doc', content: [titleHeading(title), ...content] }
}

export function applyTitle(doc: TipTapNode, title: string): TipTapNode {
  return composeNoteDoc(title, stripLeadingH1(doc))
}

export function applyBody(title: string, body: TipTapNode): { title: string; doc: TipTapNode; lifted: boolean } {
  const leading = body.content?.[0]
  if (isH1(leading)) {
    const lifted = plainText(leading)
    if (lifted.trim()) {
      return { title: lifted, doc: composeNoteDoc(lifted, stripLeadingH1(body)), lifted: true }
    }
  }
  return { title, doc: composeNoteDoc(title, body), lifted: false }
}

export function noteForSave(note: StrideNote): StrideNote {
  const title = isPlaceholderTitle(note.title) ? 'Untitled' : note.title
  return { ...note, title, doc: composeNoteDoc(title, stripLeadingH1(note.doc)) }
}

export function slugTitle(title: string): string {
  const slug = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'note'
}

export function noteFileName(id: string): string {
  return `${id}${NOTE_EXT}`
}

export function isNoteFileName(name: string): boolean {
  return name.endsWith(NOTE_EXT) && !name.startsWith('.')
}

const WIKILINK = /\[\[[^\]]+\]\]/g

export function wikilinkTargets(value: unknown): string[] {
  if (typeof value === 'string') {
    const found = value.match(WIKILINK)
    return found ? found.map((token) => token.slice(2, -2).trim()).filter(Boolean) : []
  }
  if (Array.isArray(value)) return value.flatMap((item) => wikilinkTargets(item))
  return []
}

export function bodyWikilinks(doc: TipTapNode): string[] {
  const targets: string[] = []
  const walk = (current: TipTapNode | undefined) => {
    if (!current) return
    if (current.type === 'wikilink' && typeof current.attrs?.target === 'string') {
      const target = current.attrs.target.trim()
      if (target) targets.push(target)
    }
    if (current.type === 'text' && current.text) targets.push(...wikilinkTargets(current.text))
    current.content?.forEach(walk)
  }
  walk(doc)
  return targets
}

export function isHiddenProperty(key: string): boolean {
  return key.startsWith('_')
}

export function propertyKind(value: NoteProperty | undefined): PropertyKind {
  if (typeof value === 'number') return 'number'
  if (typeof value === 'boolean') return 'boolean'
  if (Array.isArray(value)) return 'list'
  return 'string'
}

function asNoteProperty(value: unknown): NoteProperty | undefined {
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return value
  return undefined
}

function sanitizeProperties(raw: unknown): Record<string, NoteProperty> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const properties: Record<string, NoteProperty> = {}
  for (const [key, value] of Object.entries(raw)) {
    const property = asNoteProperty(value)
    if (property !== undefined) properties[key] = property
  }
  return properties
}

const LIST_TOKEN = /\[\[[^\]]+\]\]|\S+/g

export function parseListInput(raw: string): string[] {
  return raw.match(LIST_TOKEN) ?? []
}

export function parseFiniteNumber(raw: string): number | undefined {
  const trimmed = raw.trim()
  if (!trimmed) return undefined
  try {
    const value: unknown = JSON.parse(trimmed)
    if (typeof value === 'number' && Number.isFinite(value)) return value
  } catch {
    return undefined
  }
  return undefined
}

export function parsePropertyInput(raw: string): NoteProperty {
  if (raw.trim() === '') return ''
  const links = raw.match(/\[\[[^\]]+\]\]/g)
  if (!links) return raw
  const remainder = raw.replace(/\[\[[^\]]+\]\]/g, '').replace(/[\s,]+/g, '')
  if (remainder.length > 0) return raw
  return links
}

export function formatProperty(value: NoteProperty | undefined): string {
  if (value === undefined) return ''
  if (Array.isArray(value)) return value.join(' ')
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return value
}
