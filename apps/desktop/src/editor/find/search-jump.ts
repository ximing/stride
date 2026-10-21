import type { Node as PmNode } from '@tiptap/pm/model'

type CharPos = { pos: number; atom: boolean }

function isSpace(char: string): boolean {
  return /\s/.test(char)
}

function pieces(doc: PmNode): { text: string; pos: number; atom: boolean }[] {
  const list: { text: string; pos: number; atom: boolean }[] = []
  doc.descendants((node, pos) => {
    if (node.isText) {
      const text = node.text ?? ''
      if (text) list.push({ text, pos, atom: false })
      return false
    }
    if (node.type.name === 'wikilink') {
      const target = node.attrs.target
      if (typeof target === 'string' && target) list.push({ text: target, pos, atom: true })
      return false
    }
    return true
  })
  return list
}

// Same join, collapse, and trim as plainText, with a ProseMirror position per output character.
function plainMap(doc: PmNode): { text: string; at: (CharPos | null)[] } {
  const parts = pieces(doc)
  const raw: string[] = []
  const rawAt: (CharPos | null)[] = []
  parts.forEach((part, index) => {
    if (index > 0) {
      raw.push(' ')
      rawAt.push(null)
    }
    for (let i = 0; i < part.text.length; i += 1) {
      raw.push(part.text[i] ?? '')
      rawAt.push(part.atom ? { pos: part.pos, atom: true } : { pos: part.pos + i, atom: false })
    }
  })
  const chars: string[] = []
  const at: (CharPos | null)[] = []
  let cursor = 0
  while (cursor < raw.length && isSpace(raw[cursor] ?? '')) cursor += 1
  while (cursor < raw.length) {
    const char = raw[cursor] ?? ''
    if (isSpace(char)) {
      let next = cursor
      while (next < raw.length && isSpace(raw[next] ?? '')) next += 1
      if (next >= raw.length) break
      chars.push(' ')
      at.push(rawAt[cursor] ?? null)
      cursor = next
      continue
    }
    chars.push(char)
    at.push(rawAt[cursor] ?? null)
    cursor += 1
  }
  return { text: chars.join(''), at }
}

function nearest(at: (CharPos | null)[], index: number, direction: 1 | -1): CharPos | null {
  let cursor = index
  while (cursor >= 0 && cursor < at.length) {
    const found = at[cursor]
    if (found) return found
    cursor += direction
  }
  return null
}

function place(doc: PmNode, pos: number): number {
  return Math.max(0, Math.min(pos, doc.content.size))
}

// `storedPlain` is plainText(note.doc). The editor document omits a leading title H1, so that prefix is skipped.
export function plainTextSelection(
  doc: PmNode,
  storedPlain: string,
  offset: number,
  length: number,
): { from: number; to: number } | null {
  const mapped = plainMap(doc)
  let start = offset
  if (mapped.text.length > 0 && storedPlain !== mapped.text && storedPlain.endsWith(mapped.text)) {
    start -= storedPlain.length - mapped.text.length
  }
  if (mapped.text.length === 0) return null
  if (start < 0) start = 0
  if (start >= mapped.text.length) {
    const last = nearest(mapped.at, mapped.text.length - 1, -1)
    if (!last) return null
    const cursor = place(doc, last.pos + 1)
    return { from: cursor, to: cursor }
  }
  const fromChar = nearest(mapped.at, start, 1) ?? nearest(mapped.at, start, -1)
  if (!fromChar) return null
  const end = Math.min(mapped.text.length, start + Math.max(0, length))
  if (end <= start) {
    const cursor = place(doc, fromChar.pos)
    return { from: cursor, to: cursor }
  }
  const toChar = nearest(mapped.at, end - 1, -1) ?? fromChar
  const from = place(doc, fromChar.pos)
  const to = place(doc, Math.max(from, toChar.pos + 1))
  return { from, to }
}
