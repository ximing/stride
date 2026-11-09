// Standalone skill implementation: imports must stay inside this skill or node:*.
import { parseFragment } from './markdown.mjs'

export function fail(code, message) {
  throw Object.assign(new Error(message), { code })
}

export const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

export function validateDocument(file) {
  if (!object(file) || file.format !== 'tiptap' || typeof file.title !== 'string' ||
      typeof file.type !== 'string' || !object(file.properties) || file.doc?.type !== 'doc') {
    fail('INVALID_DOCUMENT', 'Expected format=tiptap, string title/type, properties object, and doc.type=doc.')
  }
  for (const value of Object.values(file.properties)) {
    if (!(typeof value === 'string' || typeof value === 'boolean' ||
        (typeof value === 'number' && Number.isFinite(value)) ||
        (Array.isArray(value) && value.every((item) => typeof item === 'string')))) {
      fail('INVALID_DOCUMENT', 'Property values must be strings, numbers, booleans or string arrays.')
    }
  }
  function walk(node) {
    if (!object(node) || typeof node.type !== 'string' || !node.type.trim()) fail('INVALID_DOCUMENT', 'Invalid TipTap node.')
    if (node.type === 'text' && (typeof node.text !== 'string' || !node.text.length || node.content !== undefined)) {
      fail('INVALID_DOCUMENT', 'Text nodes must contain nonempty text and no child nodes.')
    }
    if (node.attrs !== undefined && !object(node.attrs)) fail('INVALID_DOCUMENT', 'Invalid node attributes.')
    if (node.marks !== undefined && (!Array.isArray(node.marks) || !node.marks.every((m) =>
      object(m) && typeof m.type === 'string' && (m.attrs === undefined || object(m.attrs))))) {
      fail('INVALID_DOCUMENT', 'Invalid node marks.')
    }
    if (node.content !== undefined) {
      if (!Array.isArray(node.content)) fail('INVALID_DOCUMENT', 'Node content must be an array.')
      node.content.forEach(walk)
    }
  }
  walk(file.doc)
}

export function nodeText(node) {
  if (!node) return ''
  if (node.type === 'text') return node.text
  if (node.type === 'hardBreak') return '\n'
  if (node.type === 'wikilink') return `[[${node.attrs?.target ?? ''}${node.attrs?.alias ? `|${node.attrs.alias}` : ''}]]`
  if (node.type === 'inlineMath') return `$${node.attrs?.latex ?? ''}$`
  if (node.type === 'blockMath') return `$$${node.attrs?.latex ?? ''}$$`
  if (node.type === 'image') return node.attrs?.alt ? `![${node.attrs.alt}](${node.attrs.src ?? ''})` : String(node.attrs?.src ?? '')
  return (node.content ?? []).map(nodeText).join('')
}

/** Visible title of a heading: text and wikilink targets, joined like core plainText. */
export function visibleTitle(node) {
  const parts = []
  const walk = (current) => {
    if (!current) return
    if (current.type === 'text') parts.push(current.text)
    else if (current.type === 'wikilink' && typeof current.attrs?.target === 'string' && current.attrs.target) parts.push(current.attrs.target)
    current.content?.forEach(walk)
  }
  walk(node)
  return parts.join(' ').replace(/\s+/g, ' ').trim()
}

export function effectiveTitle(file, id) {
  // Match core's leadingH1Text -> plainText, including its text-node spacing.
  const first = file.doc.content?.[0]
  if (first?.type === 'heading' && first.attrs?.level === 1) {
    const title = visibleTitle(first)
    if (title) return title
  }
  return file.title.trim() ? file.title : id
}

export function indexNodes(doc) {
  const refs = new Map()
  function walk(node, path) {
    if (path.length) refs.set(`b${path.join('.')}`, node)
    node.content?.forEach((child, i) => walk(child, [...path, i]))
  }
  walk(doc, [])
  return refs
}

export function describe(id, revision, file) {
  return {
    id, title: effectiveTitle(file, id), revision,
    blocks: [...indexNodes(file.doc)].map(([ref, node]) => ({
      ref, type: node.type, text: nodeText(node),
      ...(node.type === 'heading' ? { level: node.attrs?.level } : {}),
      ...(typeof node.attrs?.language === 'string' && node.attrs.language ? { language: node.attrs.language } : {}),
      ...(node.type === 'taskItem' ? { checked: node.attrs?.checked === true } : {}),
      ...(node.type === 'callout' && typeof node.attrs?.kind === 'string' ? { kind: node.attrs.kind } : {}),
    })),
    document: file,
  }
}

function locate(root, target) {
  for (let i = 0; i < (root.content?.length ?? 0); i++) {
    const child = root.content[i]
    if (child === target) return { parent: root, index: i }
    const nested = locate(child, target)
    if (nested) return nested
  }
  return null
}

const simpleNodes = new Set(['paragraph', 'heading', 'text', 'hardBreak', 'blockquote', 'bulletList', 'orderedList', 'listItem', 'taskList', 'taskItem'])
function containsRich(node) {
  return !simpleNodes.has(node.type) || (node.content ?? []).some(containsRich)
}

function paragraphs(value) {
  if (typeof value !== 'string') fail('ARGUMENT', 'text must be a string (literal text, not Markdown).')
  return value.replace(/\r\n?/g, '\n').split(/\n\n+/).map((part) => {
    const content = []
    part.split('\n').forEach((line, i) => {
      if (i) content.push({ type: 'hardBreak' })
      if (line) content.push({ type: 'text', text: line })
    })
    return content.length ? { type: 'paragraph', content } : { type: 'paragraph' }
  })
}

export function editDocument(file, refs, op) {
  const doc = file.doc
  const resolve = (ref) => {
    const node = refs.get(ref)
    if (!node || !locate(doc, node)) fail('BLOCK_NOT_FOUND', `Unknown or already deleted block ${ref}. Read again for new references.`)
    return node
  }
  const protectTitle = (node) => {
    const first = doc.content?.[0]
    if (first?.type === 'heading' && first.attrs?.level === 1 && (first === node || locate(first, node))) {
      fail('TITLE_PROTECTED', 'This edits the leading title H1. Rename requires separate title/reference maintenance.')
    }
  }
  if (op.op === 'insert' || op.op === 'insert-markdown') {
    if (op.before !== undefined && op.after !== undefined) fail('ARGUMENT', 'Use before OR after, not both.')
    const parsed = op.op === 'insert' ? { blocks: paragraphs(op.text), warnings: [] } : parseFragment(op.markdown)
    doc.content ??= []
    let index = doc.content.length
    const ref = op.before ?? op.after
    if (ref !== undefined) {
      const node = resolve(ref)
      const at = locate(doc, node)
      if (at.parent !== doc) fail('ARGUMENT', 'insert accepts top-level references only.')
      if (op.before !== undefined) protectTitle(node)
      index = at.index + (op.after !== undefined ? 1 : 0)
    }
    doc.content.splice(index, 0, ...parsed.blocks)
    return parsed.warnings
  }
  const node = resolve(op.block)
  protectTitle(node)
  if (op.op === 'replace-text') {
    if (typeof op.old !== 'string' || !op.old || typeof op.new !== 'string') fail('ARGUMENT', 'old must be nonempty text and new must be a string.')
    const matches = []
    const walk = (current) => {
      if (current.type === 'text') {
        let start = 0
        while ((start = current.text.indexOf(op.old, start)) !== -1) {
          matches.push({ node: current, start }); start += 1
        }
      }
      current.content?.forEach(walk)
    }
    walk(node)
    if (matches.length !== 1) fail('TEXT_MATCH', 'Expected one exact match within one text node. Read smaller refs for repeated text; split cross-format replacements into separate operations.')
    const match = matches[0]
    match.node.text = match.node.text.slice(0, match.start) + op.new + match.node.text.slice(match.start + op.old.length)
    if (!match.node.text) {
      const at = locate(doc, match.node)
      at.parent.content.splice(at.index, 1)
    }
    return []
  }
  if (op.op === 'replace-block') {
    if (node.type === 'text') fail('ARGUMENT', 'replace-block replaces a whole block. Use replace-text to change inline text.')
    const at = locate(doc, node)
    if (at.parent !== doc) fail('ARGUMENT', 'replace-block accepts top-level blocks only.')
    if (containsRich(node) && op.allowRichDelete !== true) {
      fail('RICH_CONTENT', 'Block includes media, links, code, table or unknown nodes. Explicit allowRichDelete=true is required to replace all its content.')
    }
    const parsed = parseFragment(op.markdown)
    doc.content.splice(at.index, 1, ...parsed.blocks)
    return parsed.warnings
  }
  if (op.op === 'delete-block') {
    if (node.type === 'text') fail('ARGUMENT', 'Use replace-text with new="" to remove inline text.')
    if (containsRich(node) && op.allowRichDelete !== true) fail('RICH_CONTENT', 'Block includes media, links, code, table or unknown nodes. Explicit allowRichDelete=true is required to delete all its content.')
    const at = locate(doc, node)
    const paragraphParents = new Set(['doc', 'blockquote', 'listItem', 'taskItem', 'tableCell', 'tableHeader'])
    const listParents = new Set(['bulletList', 'orderedList', 'taskList'])
    if (!paragraphParents.has(at.parent.type) && !listParents.has(at.parent.type)) fail('CONTAINER', 'Deleting from this container is unsupported; preserve its schema.')
    if (listParents.has(at.parent.type) && at.parent.content.length === 1) fail('CONTAINER', 'Delete the list container instead of its last item.')
    at.parent.content.splice(at.index, 1)
    if (!at.parent.content.length || (['listItem', 'taskItem'].includes(at.parent.type) && at.parent.content[0].type !== 'paragraph')) {
      at.parent.content.unshift({ type: 'paragraph' })
    }
    return []
  }
  fail('ARGUMENT', `Unknown operation ${op.op}.`)
}
