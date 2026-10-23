import type { BlockContent, List, ListItem, PhrasingContent, RootContent, Table, TableCell } from 'mdast'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import { normalizeLatexMathDelimiters } from '../math/latex-delimiters'

export type PmMark = { type: string; attrs?: Record<string, unknown> }

export type PmNode = {
  type: string
  attrs?: Record<string, unknown>
  text?: string
  marks?: PmMark[]
  content?: PmNode[]
}

/** Vault attachments and http(s) URLs. Drop data URLs and other schemes. */
export function safeMediaSrc(url: string): string | null {
  if (url.startsWith('attachments/') && !url.includes('..') && !url.includes('\\')) return url
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') return parsed.href
  } catch {
    return null
  }
  return null
}

function withContent(type: string, content: PmNode[], attrs?: PmNode['attrs']): PmNode {
  const node: PmNode = { type }
  if (attrs !== undefined) node.attrs = attrs
  if (content.length > 0) node.content = content
  return node
}

function textNode(value: string, marks: PmMark[]): PmNode {
  const node: PmNode = { type: 'text', text: value }
  if (marks.length > 0) node.marks = marks
  return node
}

type SourcedNode = {
  position?: { start: { offset?: number }; end: { offset?: number } }
  value?: unknown
}

/** Offsets refer to the normalized markdown passed to remark, not a second parse. */
function sourceText(node: SourcedNode, source: string): string {
  const start = node.position?.start.offset
  const end = node.position?.end.offset
  if (typeof start === 'number' && typeof end === 'number' && start >= 0 && end <= source.length && start <= end) {
    const slice = source.slice(start, end)
    if (slice) return slice
  }
  return typeof node.value === 'string' ? node.value : ''
}

function unrecognizedBlock(node: SourcedNode, source: string): PmNode[] {
  const raw = sourceText(node, source)
  if (!raw.trim()) return []
  return [withContent('paragraph', [textNode(raw, [])])]
}

function isMermaidFence(lang: string | null | undefined): boolean {
  if (typeof lang !== 'string') return false
  const key = lang.trim().toLowerCase()
  return key === 'mermaid' || key === 'mmd'
}

function phrasingToPm(nodes: PhrasingContent[], marks: PmMark[], source: string): PmNode[] {
  const out: PmNode[] = []
  for (const node of nodes) {
    switch (node.type) {
      case 'text':
        if (node.value) out.push(textNode(node.value, marks))
        break
      case 'strong':
        out.push(...phrasingToPm(node.children, [...marks, { type: 'bold' }], source))
        break
      case 'emphasis':
        out.push(...phrasingToPm(node.children, [...marks, { type: 'italic' }], source))
        break
      case 'delete':
        out.push(...phrasingToPm(node.children, [...marks, { type: 'strike' }], source))
        break
      case 'inlineCode':
        if (node.value) out.push(textNode(node.value, [...marks, { type: 'code' }]))
        break
      case 'link': {
        const attrs: Record<string, unknown> = { href: node.url }
        if (node.title) attrs.title = node.title
        out.push(...phrasingToPm(node.children, [...marks, { type: 'link', attrs }], source))
        break
      }
      case 'break':
        out.push({ type: 'hardBreak' })
        break
      case 'inlineMath': {
        const latex = node.value.trim()
        if (latex) out.push({ type: 'inlineMath', attrs: { latex } })
        break
      }
      default: {
        const raw = sourceText(node, source)
        if (raw) out.push(textNode(raw, marks))
        break
      }
    }
  }
  return out
}

/** Images are block atoms, so a paragraph splits around them. */
function paragraphBlocks(children: PhrasingContent[], source: string): PmNode[] {
  const blocks: PmNode[] = []
  let buf: PhrasingContent[] = []
  const flush = () => {
    const content = phrasingToPm(buf, [], source)
    buf = []
    if (content.length > 0) blocks.push(withContent('paragraph', content))
  }
  for (const child of children) {
    if (child.type === 'image') {
      flush()
      const src = safeMediaSrc(child.url)
      if (!src) continue
      const attrs: Record<string, unknown> = { src }
      if (child.alt) attrs.alt = child.alt
      if (child.title) attrs.title = child.title
      blocks.push({ type: 'image', attrs })
      continue
    }
    buf.push(child)
  }
  flush()
  if (blocks.length === 0) blocks.push({ type: 'paragraph' })
  return blocks
}

function isTaskList(node: List): boolean {
  return node.children.some((item) => item.checked !== null && item.checked !== undefined)
}

function listItemContent(node: ListItem, source: string): PmNode[] {
  return node.children.flatMap((child) => flowToPm(child, source))
}

function listToPm(node: List, source: string): PmNode {
  if (isTaskList(node)) {
    return withContent(
      'taskList',
      node.children.map((item) =>
        withContent('taskItem', listItemContent(item, source), { checked: item.checked === true }),
      ),
    )
  }
  const type = node.ordered === true ? 'orderedList' : 'bulletList'
  const attrs = node.ordered === true && node.start != null && node.start !== 1 ? { start: node.start } : undefined
  return withContent(
    type,
    node.children.map((item) => withContent('listItem', listItemContent(item, source))),
    attrs,
  )
}

function tableCellToPm(node: TableCell, header: boolean, source: string): PmNode {
  return withContent(header ? 'tableHeader' : 'tableCell', [
    withContent('paragraph', phrasingToPm(node.children, [], source)),
  ])
}

function tableToPm(node: Table, source: string): PmNode {
  return withContent(
    'table',
    node.children.map((row, index) =>
      withContent(
        'tableRow',
        row.children.map((cell) => tableCellToPm(cell, index === 0, source)),
      ),
    ),
  )
}

function flowToPm(node: BlockContent | RootContent, source: string): PmNode[] {
  switch (node.type) {
    case 'paragraph':
      return paragraphBlocks(node.children, source)
    case 'heading':
      return [withContent('heading', phrasingToPm(node.children, [], source), { level: node.depth })]
    case 'list':
      return [listToPm(node, source)]
    case 'code': {
      const content = node.value === '' ? [] : [textNode(node.value, [])]
      if (isMermaidFence(node.lang)) return [withContent('mermaid', content, { view: 'render' })]
      const attrs = node.lang ? { language: node.lang } : undefined
      return [withContent('codeBlock', content, attrs)]
    }
    case 'blockquote':
      return [
        withContent(
          'blockquote',
          node.children.flatMap((child) => flowToPm(child, source)),
        ),
      ]
    case 'thematicBreak':
      return [{ type: 'horizontalRule' }]
    case 'table':
      return [tableToPm(node, source)]
    case 'math': {
      const latex = node.value.trim()
      if (!latex) return []
      return [{ type: 'blockMath', attrs: { latex } }]
    }
    default:
      return unrecognizedBlock(node, source)
  }
}

export function parseMarkdownToPmJSON(markdown: string): PmNode {
  const source = normalizeLatexMathDelimiters(markdown)
  const tree = unified().use(remarkParse).use(remarkGfm).use(remarkMath).parse(source)
  const content: PmNode[] = []
  for (const child of tree.children) content.push(...flowToPm(child, source))
  return { type: 'doc', content }
}
