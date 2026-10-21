import { parseMarkdownToPmJSON, type PmNode } from './markdown-pm'

/**
 * Clipboard Markdown becomes rich text only when the source actually uses
 * Markdown syntax. A multi-line note that merely bolds one word stays one
 * paragraph per line. A document (a blank line, or a heading, list, fence,
 * table, or similar block) is parsed as Markdown, and a single newline inside
 * a paragraph becomes a space. Rich HTML that is not just a wrapper around
 * that same source is left for the editor's HTML paste.
 */

const RICH_TAG =
  /<\s*\/?\s*(?:a|b|blockquote|code|del|em|h[1-6]|hr|i|img|li|ol|pre|s|strike|strong|sub|sup|table|tbody|td|tfoot|th|thead|tr|u|ul|video)\b/i

const BLOCK_SIGNALS: RegExp[] = [
  /^[ \t]{0,3}#{1,6}[ \t]+\S/m,
  /^[ \t]{0,3}(?:```|~~~)/m,
  /^[ \t]{0,3}>[ \t]?\S/m,
  /^[ \t]{0,3}[-*+][ \t]+\[[ xX]\][ \t]+\S/m,
  /^[ \t]{0,3}[-*+][ \t]+\S/m,
  /^[ \t]{0,3}\d{1,9}[.)][ \t]+\S/m,
  /^[ \t]{0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})[ \t]*$/m,
  /^[ \t]{0,3}\|?[ \t]*:?-{3,}:?[ \t]*(?:\|[ \t]*:?-{3,}:?[ \t]*)+\|?[ \t]*$/m,
  /^[^\n]+\n[ \t]{0,3}=+[ \t]*$/m,
  /^[ \t]*\$\$[ \t]*$/m,
  /^[ \t]*\\\[\[ \t]*$/m,
]

const INLINE_SIGNALS: RegExp[] = [
  /\*\*\S(?:[^*\n]|\*(?!\*))*\*\*/,
  /__\S(?:[^_\n]|_(?!_))*__/,
  /~~\S[^~\n]*~~/,
  /`[^`\n]+`/,
  /!\[[^\]]{0,500}\]\([^)\s]{1,2000}\)/,
  /\[[^\]\n]{1,500}\]\([^)\s]{1,2000}\)/,
  /<https?:\/\/[^>\s]+>/,
]

const CURRENCY = /^[\d,.\s]+$/
const MATH_SIGNAL = /[\\^_=+*/<>{}[\]|]/
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
}

export function htmlClipboardIsRich(html: string): boolean {
  if (!html) return false
  return RICH_TAG.test(stripNoise(html))
}

/** PM blocks to insert, or null when the editor should keep its normal paste. */
export function markdownPasteBlocks(plain: string, html = ''): PmNode[] | null {
  const richHtml = htmlClipboardIsRich(html)
  const source = normalizeSource(plain) || (richHtml ? '' : normalizeSource(looseTextFromHtml(html)))
  if (!source.trim()) return null
  if (richHtml && !sameCompact(looseTextFromHtml(html), plain)) return null
  if (!hasMarkdownSignal(source)) return null
  const blocks = softenDocument(parseBlocks(source))
  if (!blocks.some(isRich)) return null
  return blocks
}

function parseBlocks(text: string): PmNode[] {
  if (prefersDocument(text)) return parseMarkdownToPmJSON(text).content ?? []
  return text.split('\n').flatMap((line) => parseMarkdownToPmJSON(line).content ?? [])
}

function prefersDocument(text: string): boolean {
  return !text.includes('\n') || /\n[ \t]*\n/.test(text) || hasBlockSignal(text)
}

function hasMarkdownSignal(text: string): boolean {
  return hasBlockSignal(text) || hasInlineSignal(text) || hasMathSignal(text)
}

function hasBlockSignal(text: string): boolean {
  return BLOCK_SIGNALS.some((pattern) => pattern.test(text))
}

function hasInlineSignal(text: string): boolean {
  if (INLINE_SIGNALS.some((pattern) => pattern.test(text))) return true
  if (hasWrappedEmphasis(text, '*')) return true
  return hasWrappedEmphasis(text, '_')
}

function hasWrappedEmphasis(text: string, marker: '*' | '_'): boolean {
  const pattern =
    marker === '*'
      ? /(?<!\*)\*(?!\s|\*)([^*\n]+?)\*(?!\*)/g
      : /(?<!_)_(?!\s|_)([^_\n]+?)_(?!_)/g
  for (const match of text.matchAll(pattern)) {
    const raw = match[0]
    const start = match.index
    if (!raw || start === undefined) continue
    const inner = match[1] ?? ''
    if (!inner || /\s/.test(inner[0] ?? '') || /\s/.test(inner[inner.length - 1] ?? '')) continue
    const before = start > 0 ? (text[start - 1] ?? '') : ''
    const after = text[start + raw.length] ?? ''
    if (marker === '*') {
      if (isAsciiWord(before) || isAsciiWord(after)) continue
      return true
    }
    if (isWordOrCjk(before) || isWordOrCjk(after)) continue
    return true
  }
  return false
}

function isAsciiWord(char: string): boolean {
  return char !== '' && /[A-Za-z0-9]/.test(char)
}

function isWordOrCjk(char: string): boolean {
  if (char === '') return false
  return /[\p{L}\p{N}]/u.test(char)
}

function hasMathSignal(text: string): boolean {
  if (/\$\$[^$]*\S[^$]*\$\$/.test(text) || /\\\[[\s\S]+?\\\]/.test(text) || /\\\([\s\S]+?\\\)/.test(text)) {
    return true
  }
  for (const match of text.matchAll(/(?<!\\)\$(?!\$)([^$\n]+)\$(?!\$)/g)) {
    const inner = (match[1] ?? '').trim()
    if (!inner || CURRENCY.test(inner)) continue
    if (!/\s/.test(inner) || MATH_SIGNAL.test(inner)) return true
  }
  return false
}

function isRich(node: PmNode): boolean {
  if (node.type !== 'doc' && node.type !== 'paragraph' && node.type !== 'text') return true
  if (node.marks && node.marks.length > 0) return true
  return (node.content ?? []).some(isRich)
}

function softenDocument(blocks: PmNode[]): PmNode[] {
  return blocks.flatMap((block) => {
    const next = softenNode(block, false)
    return next ? [next] : []
  })
}

function softenNode(node: PmNode, inCode: boolean): PmNode | null {
  const code = inCode || node.type === 'codeBlock' || node.type === 'mermaid'
  if (node.type === 'text') {
    if (!node.text) return null
    if (code || !node.text.includes('\n')) return node
    const text = node.text.replace(/[ \t]*\n[ \t]*/g, ' ')
    if (!text) return null
    return { ...node, text }
  }
  if (!node.content) return node
  const content = node.content.flatMap((child) => {
    const next = softenNode(child, code)
    return next ? [next] : []
  })
  if (content.length === 0) {
    const rest = { ...node }
    delete rest.content
    return rest
  }
  return { ...node, content }
}

function normalizeSource(text: string): string {
  return text
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '')
}

function sameCompact(htmlText: string, plain: string): boolean {
  return compact(htmlText) === compact(plain)
}

function compact(text: string): string {
  return text.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim()
}

function stripNoise(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<meta\b[^>]*>/gi, '')
    .replace(/<link\b[^>]*>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
}

function looseTextFromHtml(html: string): string {
  if (!html) return ''
  const withBreaks = stripNoise(html)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|h[1-6]|li|tr|blockquote|pre)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
  return decodeEntities(withBreaks).replace(/\u00a0/g, ' ')
}

function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (entity, body: string) => {
    if (body.startsWith('#')) {
      const hex = body[1] === 'x' || body[1] === 'X'
      const code = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10)
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return entity
      return String.fromCodePoint(code)
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? entity
  })
}
