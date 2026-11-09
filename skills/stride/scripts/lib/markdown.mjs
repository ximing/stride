// Standalone Markdown → Stride note converter. Imports stay inside this skill or node:*.
// Node shapes follow the desktop editor (TipTap): headings, marks, lists, tasks,
// tables, code, mermaid, math, images, wikilinks, and callouts. Unsupported
// syntax is kept as text and reported in warnings — never dropped silently.
import { fail, validateDocument, visibleTitle } from './document.mjs'

const CALLOUT = /^\[!(note|tip|hint|warning|caution|important|danger|info)\][ \t]?/i

function warn(warnings, code, message) {
  warnings.push({ code, message })
}

function textNode(text, marks = []) {
  if (!text) return null
  const node = { type: 'text', text }
  if (marks.length) {
    node.marks = marks.map((mark) => (mark.attrs ? { type: mark.type, attrs: { ...mark.attrs } } : { type: mark.type }))
  }
  return node
}

function withContent(type, content, attrs) {
  const node = { type }
  if (attrs && Object.keys(attrs).length) node.attrs = attrs
  if (content?.length) node.content = content
  return node
}

function addMark(nodes, mark) {
  return nodes.map((node) => (node.type === 'text' ? textNode(node.text, [...(node.marks ?? []), mark]) : node))
}

function sameMarks(a, b) {
  return JSON.stringify(a ?? []) === JSON.stringify(b ?? [])
}

function mergeText(nodes) {
  const out = []
  for (const node of nodes) {
    if (!node) continue
    if (node.type === 'text' && !node.text) continue
    const prev = out[out.length - 1]
    if (node.type === 'text' && prev?.type === 'text' && sameMarks(prev.marks, node.marks)) prev.text += node.text
    else out.push(node)
  }
  return out
}

function isBlank(line) {
  return /^[ \t]*$/.test(line ?? '')
}

function indentOf(line) {
  let n = 0
  for (const char of line) {
    if (char === ' ') n += 1
    else if (char === '\t') n += 4
    else break
  }
  return n
}

function stripColumns(line, columns) {
  let index = 0
  let left = columns
  while (index < line.length && left > 0) {
    if (line[index] === ' ') { index += 1; left -= 1 }
    else if (line[index] === '\t') { index += 1; left -= 4 }
    else break
  }
  return line.slice(index)
}

function isProperty(value) {
  return typeof value === 'string' || typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value)) ||
    (Array.isArray(value) && value.every((item) => typeof item === 'string'))
}

function parseScalar(raw) {
  const value = raw.trim()
  if (!value) return ''
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    const body = value.slice(1, -1)
    return value.startsWith('"') ? body.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\') : body.replace(/''/g, "'")
  }
  if (value === 'true') return true
  if (value === 'false') return false
  if (value === 'null' || value === '~') return null
  if (/^-?\d+$/.test(value)) {
    const number = Number(value)
    if (Number.isSafeInteger(number)) return number
  }
  if (/^-?\d+\.\d+$/.test(value)) {
    const number = Number(value)
    if (Number.isFinite(number)) return number
  }
  return value
}

function parseFlowValue(raw) {
  const value = raw.trim()
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return parseScalar(value)
  }
  if (value.startsWith('[') && value.endsWith(']')) return splitFlow(value)
  return parseScalar(value)
}

function splitFlow(raw) {
  const inner = raw.slice(1, -1).trim()
  if (!inner) return []
  const parts = []
  let buf = ''
  let quote = ''
  let depth = 0
  for (const char of inner) {
    if (quote) {
      buf += char
      if (char === quote) quote = ''
      continue
    }
    if (char === '"' || char === "'") { quote = char; buf += char; continue }
    if (char === '[' || char === '{') { depth += 1; buf += char; continue }
    if ((char === ']' || char === '}') && depth > 0) { depth -= 1; buf += char; continue }
    if (char === ',' && depth === 0) { parts.push(parseFlowValue(buf)); buf = ''; continue }
    buf += char
  }
  if (buf.trim()) parts.push(parseFlowValue(buf))
  return parts
}

function coerceList(items, warnings, key) {
  if (items.every((item) => typeof item === 'string')) return items
  if (items.every((item) => item === null || ['string', 'number', 'boolean'].includes(typeof item))) {
    warn(warnings, 'frontmatter-coerced', `${key} list items were stored as strings.`)
    return items.map((item) => (item === null ? '' : String(item)))
  }
  return items
}

function nestedValue(nested) {
  if (nested.kind === 'list') return nested.items
  if (nested.kind === 'map') return nested.object
  if (nested.kind === 'literal') return nested.value
  return ''
}

function readLiteral(lines, start) {
  if (start >= lines.length || isBlank(lines[start]) || indentOf(lines[start]) === 0) return { value: '', next: start }
  const base = indentOf(lines[start])
  const literal = []
  let index = start
  while (index < lines.length && !isBlank(lines[index]) && indentOf(lines[index]) >= base) {
    literal.push(stripColumns(lines[index], base))
    index += 1
  }
  return { value: literal.join('\n'), next: index }
}

function readBlock(lines, start) {
  if (start >= lines.length || isBlank(lines[start]) || indentOf(lines[start]) === 0) return { kind: 'empty', next: start }
  if (/^[ \t]*-\s*/.test(lines[start])) return readList(lines, start)
  if (/^[^:\n]+:/.test(lines[start].trim())) return readMap(lines, start)
  const literal = readLiteral(lines, start)
  return { kind: 'literal', value: literal.value, next: literal.next }
}

function readList(lines, start) {
  const base = indentOf(lines[start])
  const items = []
  let index = start
  while (index < lines.length && !isBlank(lines[index]) && indentOf(lines[index]) === base && /^[ \t]*-\s*/.test(lines[index])) {
    const itemIndent = indentOf(lines[index])
    const rest = lines[index].replace(/^[ \t]*-\s*/, '')
    index += 1
    const deeper = index < lines.length && !isBlank(lines[index]) && indentOf(lines[index]) > itemIndent
    if (rest === '|' || rest === '>') {
      const literal = readLiteral(lines, index)
      items.push(literal.value)
      index = literal.next
      continue
    }
    const inlineMap = /^([A-Za-z_][A-Za-z0-9_ -]*):\s*(.*)$/.exec(rest)
    if (inlineMap) {
      const object = Object.create(null)
      const key = inlineMap[1].trim()
      const raw = inlineMap[2].trim()
      if (raw === '' && deeper) {
        const nested = readBlock(lines, index)
        if (nested.kind === 'invalid') return nested
        object[key] = nestedValue(nested)
        index = nested.kind === 'empty' ? index : nested.next
      } else object[key] = raw === '' ? '' : parseScalar(raw)
      items.push(object)
      continue
    }
    if (rest === '' || deeper) {
      if (!deeper) { items.push(rest === '' ? '' : parseScalar(rest)); continue }
      const nested = readBlock(lines, index)
      if (nested.kind === 'invalid') return nested
      const child = nestedValue(nested)
      items.push(rest === '' ? child : [parseScalar(rest), child])
      index = nested.kind === 'empty' ? index : nested.next
      continue
    }
    items.push(parseScalar(rest))
  }
  return { kind: 'list', items, next: index }
}

function readMap(lines, start) {
  const base = indentOf(lines[start])
  const object = Object.create(null)
  let index = start
  while (index < lines.length && !isBlank(lines[index]) && indentOf(lines[index]) === base) {
    const match = /^[ \t]+([^:\n]+):(.*)$/.exec(lines[index])
    if (!match) return { kind: 'invalid', message: `Unrecognized nested frontmatter: ${lines[index]}` }
    const key = match[1].trim()
    const raw = match[2].trim()
    index += 1
    if (raw === '|' || raw === '>') {
      const literal = readLiteral(lines, index)
      object[key] = literal.value
      index = literal.next
      continue
    }
    if (raw === '' && index < lines.length && !isBlank(lines[index]) && indentOf(lines[index]) > base) {
      const nested = readBlock(lines, index)
      if (nested.kind === 'invalid') return nested
      object[key] = nestedValue(nested)
      index = nested.kind === 'empty' ? index : nested.next
      continue
    }
    object[key] = parseScalar(raw)
  }
  return { kind: 'map', object, next: index }
}

function parseYaml(lines) {
  const warnings = []
  const properties = Object.create(null)
  let title
  let type
  let sawKey = false
  const seen = new Set()
  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    if (isBlank(line) || /^[ \t]*#/.test(line)) { index += 1; continue }
    const match = /^([A-Za-z_][A-Za-z0-9_ -]*):\s*(.*)$/.exec(line)
    if (!match) return { ok: false, sawKey, message: `Unrecognized frontmatter line: ${line}` }
    const key = match[1].trim()
    if (seen.has(key)) return { ok: false, sawKey: true, message: `Duplicate frontmatter key ${key}.` }
    seen.add(key)
    sawKey = true
    const raw = match[2]
    let value
    if (raw === '|' || raw === '>') {
      const literal = readLiteral(lines, index + 1)
      value = literal.value
      index = literal.next
    } else if (raw === '') {
      const nested = readBlock(lines, index + 1)
      if (nested.kind === 'invalid') return { ok: false, sawKey, message: nested.message }
      if (nested.kind === 'list') value = coerceList(nested.items, warnings, key)
      else if (nested.kind === 'map') value = nested.object
      else if (nested.kind === 'literal') value = nested.value
      else value = ''
      index = nested.kind === 'empty' ? index + 1 : nested.next
    } else if (raw.startsWith('[') && raw.endsWith(']')) {
      value = coerceList(splitFlow(raw), warnings, key)
      index += 1
    } else {
      value = parseScalar(raw)
      index += 1
    }
    if (key === 'title') {
      if (typeof value !== 'string' || !value.trim()) return { ok: false, sawKey, message: 'Frontmatter title must be a nonempty string.' }
      title = value.trim()
      continue
    }
    if (key === 'type') {
      if (typeof value !== 'string' || !value.trim()) return { ok: false, sawKey, message: 'Frontmatter type must be a nonempty string.' }
      type = value.trim()
      continue
    }
    if (value === null) {
      warn(warnings, 'frontmatter-skipped', `Omitted ${key} because Stride properties cannot store null.`)
      continue
    }
    if (!isProperty(value)) {
      properties[key] = JSON.stringify(value)
      warn(warnings, 'frontmatter-degraded', `${key} was stored as a JSON string because Stride properties cannot store nested values.`)
      continue
    }
    properties[key] = value
  }
  return { ok: true, properties, title, type, warnings }
}

function splitFrontmatter(text, warnings) {
  const empty = { body: text, properties: {}, title: undefined, type: undefined, frontmatter: false }
  if (!/^---[ \t]*\n/.test(text)) return empty
  const lines = text.split('\n')
  let end = -1
  for (let index = 1; index < lines.length; index += 1) {
    if (/^(?:---|\.\.\.)[ \t]*$/.test(lines[index])) { end = index; break }
  }
  if (end < 0) return empty
  const parsed = parseYaml(lines.slice(1, end))
  if (!parsed.ok) {
    if (parsed.sawKey) warn(warnings, 'frontmatter-unparsed', `${parsed.message} The leading --- block was left in the body.`)
    return empty
  }
  warnings.push(...parsed.warnings)
  return { body: lines.slice(end + 1).join('\n'), properties: parsed.properties, title: parsed.title, type: parsed.type, frontmatter: true }
}

const MAX_LATEX = 8000

function isLineStart(text, index) {
  return index === 0 || text[index - 1] === '\n'
}

function skipFencedCode(text, index) {
  if (!isLineStart(text, index)) return index
  let cursor = index
  let spaces = 0
  while (spaces < 3 && text[cursor] === ' ') { spaces += 1; cursor += 1 }
  const marker = text[cursor]
  if (marker !== '`' && marker !== '~') return index
  let size = 0
  while (text[cursor + size] === marker) size += 1
  if (size < 3) return index
  const openEnd = text.indexOf('\n', cursor + size)
  if (openEnd < 0) return text.length
  let line = openEnd + 1
  while (line < text.length) {
    let cursor2 = line
    let indent = 0
    while (indent < 4 && text[cursor2] === ' ') { indent += 1; cursor2 += 1 }
    if (indent < 4 && text[cursor2] === marker) {
      let closeSize = 0
      while (text[cursor2 + closeSize] === marker) closeSize += 1
      if (closeSize >= size) {
        let end = cursor2 + closeSize
        while (text[end] === ' ' || text[end] === '\t') end += 1
        if (end === text.length) return end
        if (text[end] === '\n') return end + 1
      }
    }
    const next = text.indexOf('\n', line)
    if (next < 0) return text.length
    line = next + 1
  }
  return text.length
}

function skipInlineCode(text, index) {
  if (text[index] !== '`') return index
  let size = 0
  while (text[index + size] === '`') size += 1
  const close = text.indexOf('`'.repeat(size), index + size)
  if (close < 0) return index
  return close + size
}

function skipProtected(text, index) {
  const fenced = skipFencedCode(text, index)
  if (fenced > index) return fenced
  return skipInlineCode(text, index)
}

function ownsLines(text, open, closeEnd) {
  for (let index = open - 1; index >= 0 && text[index] !== '\n'; index -= 1) {
    if (text[index] !== ' ' && text[index] !== '\t') return false
  }
  for (let index = closeEnd; index < text.length && text[index] !== '\n'; index += 1) {
    if (text[index] !== ' ' && text[index] !== '\t') return false
  }
  return true
}

function isLatexOpener(text, index, bracket) {
  if (text[index] !== '\\' || text[index + 1] !== bracket) return false
  return index === 0 || text[index - 1] !== '\\'
}

function findLatexCloser(text, from, bracket) {
  const limit = Math.min(text.length, from + MAX_LATEX)
  for (let index = from; index < limit; index += 1) {
    const protectedEnd = skipProtected(text, index)
    if (protectedEnd > index) { index = protectedEnd - 1; continue }
    if (text[index] === '\\' && text[index + 1] === bracket && text[index - 1] !== '\\') return index
  }
  return -1
}

/** Rewrite `\[...\]` / `\(...\)` the same way the editor does, outside code. */
export function normalizeLatexMathDelimiters(markdown) {
  let out = ''
  let index = 0
  while (index < markdown.length) {
    const skipped = skipProtected(markdown, index)
    if (skipped > index) { out += markdown.slice(index, skipped); index = skipped; continue }
    if (isLatexOpener(markdown, index, '[')) {
      const close = findLatexCloser(markdown, index + 2, ']')
      if (close > index) {
        const inner = markdown.slice(index + 2, close)
        const latex = inner.trim()
        const end = close + 2
        if (latex && (inner.includes('\n') || ownsLines(markdown, index, end))) {
          const own = ownsLines(markdown, index, end)
          if (own) out = out.replace(/[ \t]*$/, '')
          else if (out.length > 0 && !out.endsWith('\n')) out += '\n\n'
          let next = end
          while (next < markdown.length && markdown[next] !== '\n') next += 1
          const tail = own ? '' : markdown.slice(end, next).trim()
          if (markdown[next] === '\n') next += 1
          out += `$$\n${latex}\n$$\n`
          if (tail) out += `\n${tail}\n`
          index = next
          continue
        }
        if (latex && !inner.includes('\n')) { out += `$$${latex}$$`; index = end; continue }
      }
    }
    if (isLatexOpener(markdown, index, '(')) {
      const close = findLatexCloser(markdown, index + 2, ')')
      if (close > index) {
        const inner = markdown.slice(index + 2, close)
        const latex = inner.trim()
        if (latex && !inner.includes('\n')) {
          out += `$${latex.split('$').join('\\$')}$`
          index = close + 2
          continue
        }
      }
    }
    out += markdown[index] ?? ''
    index += 1
  }
  return out
}

function hasBreakSentinel(value) {
  return typeof value === 'string' && (value.includes('\uE000') || value.includes('\uE001'))
}

function safeMediaSrc(url) {
  if (hasBreakSentinel(url)) return null
  if (url.startsWith('attachments/') && !url.includes('..') && !url.includes('\\')) return url
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') return parsed.href
  } catch {
    return null
  }
  return null
}

function parseCodeSpan(text, index, marks) {
  if (text[index] !== '`') return null
  let size = 0
  while (text[index + size] === '`') size += 1
  const fence = '`'.repeat(size)
  const end = text.indexOf(fence, index + size)
  if (end < 0) return null
  let inner = text.slice(index + size, end)
  if (inner.startsWith(' ') && inner.endsWith(' ') && inner.trim()) inner = inner.slice(1, -1)
  if (!inner) return null
  return { nodes: [textNode(inner, [...marks, { type: 'code' }])], next: end + size }
}

function parseWrap(text, index, marker, marks, warnings, images, wordBoundary = false) {
  if (!text.startsWith(marker, index)) return null
  const prev = text[index - 1] ?? ''
  const next = text[index + marker.length] ?? ''
  if (!next || /\s/.test(next)) return null
  if (wordBoundary && /[\p{L}\p{N}_]/u.test(prev)) return null
  let cursor = index + marker.length
  while (cursor < text.length) {
    if (text[cursor] === '\\') { cursor += 2; continue }
    if (text[cursor] === '`') {
      const code = parseCodeSpan(text, cursor, marks)
      if (code) { cursor = code.next; continue }
    }
    if (text.startsWith(marker, cursor)) {
      const before = text[cursor - 1] ?? ''
      const after = text[cursor + marker.length] ?? ''
      if (!before || /\s/.test(before)) { cursor += marker.length; continue }
      if (wordBoundary && /[\p{L}\p{N}_]/u.test(after)) { cursor += marker.length; continue }
      const inner = text.slice(index + marker.length, cursor)
      if (!inner) return null
      return { nodes: parseInlines(inner, marks, warnings, images), next: cursor + marker.length }
    }
    cursor += 1
  }
  return null
}

function parseDestination(text, index) {
  let cursor = index
  let url = ''
  if (text[cursor] === '<') {
    const end = text.indexOf('>', cursor + 1)
    if (end < 0) return null
    url = text.slice(cursor + 1, end)
    cursor = end + 1
  } else {
    let depth = 0
    const start = cursor
    while (cursor < text.length && text[cursor] !== '\n') {
      if (text[cursor] === '\\') { cursor += 2; continue }
      if (text[cursor] === '(') depth += 1
      else if (text[cursor] === ')') { if (depth === 0) break; depth -= 1 }
      else if (text[cursor] === ' ' && depth === 0) break
      cursor += 1
    }
    url = text.slice(start, cursor).trim()
  }
  let title
  const titleMatch = /^[ \t]+("([^"]*)"|'([^']*)')/.exec(text.slice(cursor))
  if (titleMatch) {
    title = titleMatch[2] ?? titleMatch[3] ?? ''
    cursor += titleMatch[0].length
  }
  if (text[cursor] !== ')') return null
  if (hasBreakSentinel(url) || hasBreakSentinel(title)) return null
  return { url, title, next: cursor + 1 }
}

function parseBracket(text, index) {
  if (text[index] !== '[') return null
  let depth = 1
  let cursor = index + 1
  while (cursor < text.length && depth > 0) {
    if (text[cursor] === '\\') { cursor += 2; continue }
    if (text[cursor] === '[') depth += 1
    else if (text[cursor] === ']') {
      depth -= 1
      if (depth === 0) break
    }
    if (depth > 0) cursor += 1
  }
  if (depth !== 0) return null
  return { inner: text.slice(index + 1, cursor), next: cursor + 1 }
}

function parseInlines(text, marks, warnings = [], images = 'block') {
  const out = []
  let buf = ''
  const flush = () => {
    if (!buf) return
    const node = textNode(buf, marks)
    if (node) out.push(node)
    buf = ''
  }
  let index = 0
  while (index < text.length) {
    const char = text[index]
    if (char === '\\' && /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/.test(text[index + 1] ?? '')) {
      buf += text[index + 1]
      index += 2
      continue
    }
    const code = char === '`' ? parseCodeSpan(text, index, marks) : null
    if (code) { flush(); out.push(...code.nodes); index = code.next; continue }
    const math = char === '$' ? parseInlineMath(text, index) : null
    if (math) { flush(); out.push(math.node); index = math.next; continue }
    if (text.startsWith('[[', index)) {
      const wiki = parseWikilink(text, index)
      if (wiki) { flush(); out.push(wiki.node); index = wiki.next; continue }
    }
    if (char === '!' && text[index + 1] === '[') {
      const image = parseImage(text, index, warnings, images)
      if (image) { flush(); out.push(...image.nodes); index = image.next; continue }
    }
    if (char === '[') {
      const link = parseLink(text, index, marks, warnings, images)
      if (link) { flush(); out.push(...link.nodes); index = link.next; continue }
    }
    const auto = char === '<' ? /^<((?:https?:|mailto:)[^>\s\uE000\uE001]+)>/.exec(text.slice(index)) : null
    if (auto) {
      flush()
      out.push(textNode(auto[1], [...marks, { type: 'link', attrs: { href: auto[1] } }]))
      index += auto[0].length
      continue
    }
    const highlight = text.startsWith('==', index) ? parseWrap(text, index, '==', marks, warnings, images) : null
    if (highlight) { flush(); out.push(...addMark(highlight.nodes, { type: 'highlight' })); index = highlight.next; continue }
    const strike = text.startsWith('~~', index) ? parseWrap(text, index, '~~', marks, warnings, images) : null
    if (strike) { flush(); out.push(...addMark(strike.nodes, { type: 'strike' })); index = strike.next; continue }
    const triple = text.startsWith('***', index) ? '***' : text.startsWith('___', index) ? '___' : null
    if (triple) {
      const hit = parseWrap(text, index, triple, marks, warnings, images, triple === '___')
      if (hit) {
        flush()
        out.push(...addMark(addMark(hit.nodes, { type: 'bold' }), { type: 'italic' }))
        index = hit.next
        continue
      }
    }
    const strong = text.startsWith('**', index) ? '**' : text.startsWith('__', index) ? '__' : null
    if (strong) {
      const hit = parseWrap(text, index, strong, marks, warnings, images, strong === '__')
      if (hit) { flush(); out.push(...addMark(hit.nodes, { type: 'bold' })); index = hit.next; continue }
    }
    const em = char === '*' ? '*' : char === '_' ? '_' : null
    if (em) {
      const hit = parseWrap(text, index, em, marks, warnings, images, em === '_')
      if (hit) { flush(); out.push(...addMark(hit.nodes, { type: 'italic' })); index = hit.next; continue }
    }
    buf += char
    index += 1
  }
  flush()
  return mergeText(out)
}

function parseInlineMath(text, index) {
  if (text[index] !== '$') return null
  const display = text[index + 1] === '$'
  const fence = display ? '$$' : '$'
  const start = index + fence.length
  if (!display && /\s/.test(text[start] ?? '')) return null
  let cursor = start
  while (cursor < text.length && text[cursor] !== '\n' && text[cursor] !== '\uE000' && text[cursor] !== '\uE001') {
    if (text.startsWith(fence, cursor)) {
      if (!display && /\s/.test(text[cursor - 1] ?? '')) return null
      const latex = text.slice(start, cursor).trim()
      if (!latex) return null
      return { node: { type: 'inlineMath', attrs: { latex } }, next: cursor + fence.length }
    }
    cursor += 1
  }
  return null
}

function parseWikilink(text, index) {
  const end = text.indexOf(']]', index + 2)
  if (end < 0) return null
  const inner = text.slice(index + 2, end)
  if (!inner.trim() || inner.includes('\n') || inner.includes('\uE000') || inner.includes('\uE001')) return null
  const pipe = inner.indexOf('|')
  const target = (pipe < 0 ? inner : inner.slice(0, pipe)).trim()
  const alias = pipe < 0 ? '' : inner.slice(pipe + 1).trim()
  if (!target) return null
  const attrs = alias ? { target, alias } : { target }
  return { node: { type: 'wikilink', attrs }, next: end + 2 }
}

function parseImage(text, index, warnings, images) {
  const bracket = parseBracket(text, index + 1)
  if (!bracket || text[bracket.next] !== '(') return null
  const dest = parseDestination(text, bracket.next + 1)
  if (!dest) return null
  const raw = text.slice(index, dest.next)
  const src = safeMediaSrc(dest.url)
  if (!src || images !== 'block') {
    if (images !== 'block') warn(warnings, 'image-inline', `Image ${dest.url} is inside a heading, table cell, or link, so it stays as text.`)
    else warn(warnings, 'image-kept', `Image ${dest.url} is not an attachments/ path or http(s) URL, so it stays as text.`)
    return { nodes: [textNode(raw)], next: dest.next }
  }
  let alt = bracket.inner.trim()
  if (dest.title && !alt.includes(dest.title)) alt = alt ? `${alt} (${dest.title})` : dest.title
  const attrs = { src }
  if (alt) attrs.alt = alt
  return { nodes: [{ type: 'image', attrs }], next: dest.next }
}

function parseLink(text, index, marks, warnings, images) {
  const bracket = parseBracket(text, index)
  if (!bracket || text[bracket.next] !== '(') return null
  const dest = parseDestination(text, bracket.next + 1)
  if (!dest || !dest.url) return null
  const attrs = { href: dest.url }
  if (dest.title) attrs.title = dest.title
  const mark = { type: 'link', attrs }
  const inner = parseInlines(bracket.inner, marks, warnings, 'text')
  const nodes = addMark(inner.length ? inner : [textNode(dest.url, marks)], mark)
  if (nodes.some((node) => node.type !== 'text' && node.type !== 'hardBreak')) {
    warn(warnings, 'link-kept', `Link ${dest.url} cannot wrap a formula or wikilink, so the URL is also kept as text.`)
    const extra = textNode(dest.url, [...marks, mark])
    if (extra) nodes.push(extra)
  }
  return { nodes, next: dest.next }
}

function splitImageBlocks(nodes) {
  const blocks = []
  let buf = []
  const flush = () => {
    while (buf[0]?.type === 'text' && !buf[0].text.trim()) buf.shift()
    while (buf.at(-1)?.type === 'text' && !buf.at(-1).text.trim()) buf.pop()
    const content = mergeText(buf)
    buf = []
    if (content.length) blocks.push({ type: 'paragraph', content })
  }
  for (const node of nodes) {
    if (node.type === 'image') { flush(); blocks.push(node); continue }
    buf.push(node)
  }
  flush()
  return blocks
}

function expandBreaks(nodes) {
  const expanded = []
  for (const node of nodes) {
    if (node.type !== 'text' || (!node.text.includes('\uE000') && !node.text.includes('\uE001'))) {
      expanded.push(node)
      continue
    }
    for (const part of node.text.split(/([\uE000\uE001])/)) {
      if (part === '\uE000') expanded.push(textNode(' ', node.marks ?? []))
      else if (part === '\uE001') expanded.push({ type: 'hardBreak' })
      else if (part) expanded.push(textNode(part, node.marks ?? []))
    }
  }
  return expanded
}

function codeCarry(line, openSize) {
  let index = 0
  let size = openSize
  while (index <= line.length) {
    if (size > 0) {
      const fence = '`'.repeat(size)
      const close = line.indexOf(fence, index)
      if (close < 0) return size
      index = close + size
      size = 0
      continue
    }
    const start = line.indexOf('`', index)
    if (start < 0) return 0
    let length = 0
    while (line[start + length] === '`') length += 1
    const close = line.indexOf('`'.repeat(length), start + length)
    if (close < 0) return length
    index = close + length
  }
  return size
}

function paragraphFromLines(rawLines, warnings) {
  const pieces = []
  let openCode = 0
  rawLines.forEach((raw, lineIndex) => {
    const openAtEnd = codeCarry(raw, openCode)
    const inside = openAtEnd !== 0
    let hard = false
    let line = raw
    const more = lineIndex < rawLines.length - 1
    if (inside) {
      // A code span owns this line ending, so spaces and backslashes stay literal.
    } else if (more && /[ \t]{2}$/.test(line)) { hard = true; line = line.replace(/[ \t]+$/, '') }
    else if (more && /\\$/.test(line) && !/\\\\$/.test(line)) { hard = true; line = line.slice(0, -1).replace(/[ \t]+$/, '') }
    else line = line.replace(/[ \t]+$/, '')
    if (lineIndex > 0 && openCode === 0) line = line.replace(/^[ \t]+/, '')
    openCode = openAtEnd
    pieces.push(line)
    if (lineIndex < rawLines.length - 1) pieces.push(hard ? '\uE001' : '\uE000')
  })
  const nodes = expandBreaks(parseInlines(pieces.join(''), [], warnings, 'block'))
  let blocks = splitImageBlocks(mergeText(nodes))
  if (rawLines.length === 1 && blocks.length === 1 && blocks[0].type === 'paragraph') {
    const content = blocks[0].content ?? []
    if (content.length === 1 && content[0].type === 'inlineMath' && rawLines[0].trim().startsWith('$$')) {
      blocks = [{ type: 'blockMath', attrs: { latex: content[0].attrs.latex } }]
    }
  }
  if (!blocks.length) blocks.push({ type: 'paragraph' })
  return blocks
}

function fenceAt(line) {
  const match = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(line)
  if (!match) return null
  if (match[2][0] === '`' && match[3].includes('`')) return null
  return { indent: match[1].length, marker: match[2], info: match[3].trim() }
}

function parseFence(lines, index, warnings) {
  const open = fenceAt(lines[index])
  if (!open) return null
  const body = []
  let cursor = index + 1
  let closed = false
  while (cursor < lines.length) {
    const close = fenceAt(lines[cursor])
    if (close && close.marker[0] === open.marker[0] && close.marker.length >= open.marker.length && !close.info) {
      closed = true
      cursor += 1
      break
    }
    body.push(stripColumns(lines[cursor], open.indent))
    cursor += 1
  }
  if (!closed) warn(warnings, 'unclosed-fence', 'A code fence ran to the end of the input and was still stored as code.')
  const text = body.join('\n')
  const lang = open.info.split(/[ \t]+/)[0] ?? ''
  const content = text ? [textNode(text)] : []
  if (/^(mermaid|mmd)$/i.test(lang)) return { blocks: [withContent('mermaid', content, { view: 'render' })], next: cursor }
  return { blocks: [withContent('codeBlock', content, lang ? { language: lang } : undefined)], next: cursor }
}

function atxHeading(line) {
  const match = /^( {0,3})(#{1,6})(?:[ \t]+([^\n]*))?$/.exec(line)
  if (!match) return null
  if (match[3] === undefined && line.trim() !== match[2]) return null
  const text = (match[3] ?? '').replace(/[ \t]+#+\s*$/, '').trim()
  return { level: match[2].length, text }
}

function isHr(line) {
  return /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})[ \t]*$/.test(line)
}

function isSetext(line) {
  return /^ {0,3}(?:=+|-+)[ \t]*$/.test(line)
}

function isHtmlStart(line) {
  if (/^ {0,3}<(?:https?:\/\/|mailto:)/.test(line)) return false
  return /^ {0,3}<!--/.test(line) || /^ {0,3}<\/?[A-Za-z]/.test(line)
}

function parseHtml(lines, index, warnings) {
  if (!isHtmlStart(lines[index])) return null
  const comment = /^ {0,3}<!--/.test(lines[index])
  const collected = []
  let cursor = index
  while (cursor < lines.length) {
    collected.push(lines[cursor])
    const done = comment ? lines[cursor].includes('-->') : isBlank(lines[cursor])
    cursor += 1
    if (done) break
    if (!comment && cursor < lines.length && isBlank(lines[cursor])) break
  }
  while (collected.length && isBlank(collected[collected.length - 1])) collected.pop()
  warn(warnings, 'html-kept', 'HTML was kept as text. Stride does not render raw HTML blocks.')
  const nodes = []
  collected.forEach((line, lineIndex) => {
    if (lineIndex) nodes.push({ type: 'hardBreak' })
    if (line) nodes.push({ type: 'text', text: line })
  })
  return { blocks: [nodes.length ? { type: 'paragraph', content: nodes } : { type: 'paragraph' }], next: cursor }
}

function listMarker(line) {
  let index = 0
  let indent = 0
  while (line[index] === ' ' || line[index] === '\t') {
    indent += line[index] === '\t' ? 4 : 1
    index += 1
  }
  const match = /^([-+*]|(\d{1,9})[.)])([ \t]+)([\s\S]*)$/.exec(line.slice(index))
  if (!match) return null
  const marker = match[1]
  const ordered = Boolean(match[2])
  let text = match[4]
  let checked = null
  let pad = marker.length + match[3].length
  const task = /^\[([ xX])\][ \t]?([\s\S]*)$/.exec(text)
  if (task) {
    checked = task[1].toLowerCase() === 'x'
    pad += text.length - task[2].length
    text = task[2]
  }
  return { indent, ordered, order: ordered ? Number(match[2]) : 1, checked, contentColumn: indent + pad, text }
}

function parseList(lines, start, warnings) {
  const first = listMarker(lines[start])
  if (!first || first.indent >= 4) return null
  const items = []
  let index = start
  while (index < lines.length) {
    if (isBlank(lines[index])) {
      let look = index + 1
      while (look < lines.length && isBlank(lines[look])) look += 1
      const upcoming = look < lines.length ? listMarker(lines[look]) : null
      const sameKind = upcoming && upcoming.indent === first.indent && upcoming.ordered === first.ordered
        && (upcoming.checked !== null) === (first.checked !== null)
        && (!upcoming.ordered || upcoming.order === first.order + items.length)
      if (!sameKind) break
      index = look
    }
    const marker = listMarker(lines[index])
    if (!marker || marker.indent !== first.indent || marker.ordered !== first.ordered) break
    const itemLines = [marker.text]
    index += 1
    while (index < lines.length) {
      if (isBlank(lines[index])) {
        let look = index + 1
        while (look < lines.length && isBlank(lines[look])) look += 1
        if (look >= lines.length) { index = look; break }
        const upcoming = listMarker(lines[look])
        if (upcoming && upcoming.indent <= first.indent) break
        if (!upcoming && indentOf(lines[look]) < first.contentColumn) break
        itemLines.push('')
        index += 1
        continue
      }
      const upcoming = listMarker(lines[index])
      if (upcoming && upcoming.indent <= first.indent) break
      if (!upcoming && indentOf(lines[index]) < first.contentColumn && indentOf(lines[index]) <= first.indent) break
      itemLines.push(stripColumns(lines[index], first.contentColumn))
      index += 1
    }
    items.push({ checked: marker.checked, lines: itemLines })
  }
  if (!items.length) return null
  const task = items.some((item) => item.checked !== null)
  if (task && items.some((item) => item.checked === null)) {
    warn(warnings, 'task-list-mixed', 'A list mixed checkboxes with plain items. Plain items were stored as unchecked tasks.')
  }
  const children = items.map((item) => {
    const inner = parseBlocks(item.lines.join('\n'), warnings)
    const content = inner.length ? inner : [{ type: 'paragraph' }]
    if (content[0].type !== 'paragraph') content.unshift({ type: 'paragraph' })
    if (task) return withContent('taskItem', content, { checked: item.checked === true })
    return withContent('listItem', content)
  })
  const type = task ? 'taskList' : first.ordered ? 'orderedList' : 'bulletList'
  const attrs = !task && first.ordered && first.order > 1 ? { start: first.order } : undefined
  return { blocks: [withContent(type, children, attrs)], next: index }
}

function calloutKind(line) {
  const match = CALLOUT.exec(line ?? '')
  if (!match) return null
  const key = match[1].toLowerCase()
  if (key === 'tip' || key === 'hint') return 'tip'
  if (key === 'warning' || key === 'caution' || key === 'important' || key === 'danger') return 'warning'
  return 'note'
}

function parseQuote(lines, index, warnings) {
  if (!/^ {0,3}>/.test(lines[index])) return null
  const collected = []
  let cursor = index
  while (cursor < lines.length && /^ {0,3}>/.test(lines[cursor])) {
    collected.push(lines[cursor].replace(/^ {0,3}> ?/, ''))
    cursor += 1
  }
  const kind = calloutKind(collected[0])
  if (kind) collected[0] = collected[0].replace(CALLOUT, '')
  let content = parseBlocks(collected.join('\n'), warnings)
  if (!content.length) content = [{ type: 'paragraph' }]
  if (kind) return { blocks: [withContent('callout', content, { kind })], next: cursor }
  return { blocks: [{ type: 'blockquote', content }], next: cursor }
}

function isDelimiterRow(line) {
  if (!line.includes('|')) return false
  const cells = splitRow(line)
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell))
}

function splitRow(line) {
  let source = line.trim()
  if (source.startsWith('|')) source = source.slice(1)
  if (source.endsWith('|')) source = source.slice(0, -1)
  const cells = []
  let buf = ''
  let code = false
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === '`') { code = !code; buf += source[index]; continue }
    if (source[index] === '\\' && source[index + 1] === '|') { buf += '|'; index += 1; continue }
    if (source[index] === '|' && !code) { cells.push(buf.trim()); buf = ''; continue }
    buf += source[index]
  }
  cells.push(buf.trim())
  return cells
}

function cellNode(text, header, warnings) {
  const content = parseInlines(text, [], warnings, 'text')
  return {
    type: header ? 'tableHeader' : 'tableCell',
    content: [content.length ? { type: 'paragraph', content } : { type: 'paragraph' }],
  }
}

function parseTable(lines, index, warnings) {
  if (!lines[index]?.includes('|') || !lines[index + 1] || !isDelimiterRow(lines[index + 1])) return null
  const rows = [splitRow(lines[index])]
  let cursor = index + 2
  while (cursor < lines.length && lines[cursor].includes('|') && !isBlank(lines[cursor]) && !isDelimiterRow(lines[cursor])) {
    rows.push(splitRow(lines[cursor]))
    cursor += 1
  }
  const width = Math.max(...rows.map((row) => row.length))
  return {
    blocks: [{
      type: 'table',
      content: rows.map((row, rowIndex) => ({
        type: 'tableRow',
        content: Array.from({ length: width }, (_, column) => cellNode(row[column] ?? '', rowIndex === 0, warnings)),
      })),
    }],
    next: cursor,
  }
}

function parseMathBlock(lines, index, warnings) {
  const line = lines[index].trim()
  const single = /^\$\$([^$\n]+?)\$\$$/.exec(line)
  if (single && line === lines[index].trim()) {
    const latex = single[1].trim()
    if (!latex) return null
    return { blocks: [{ type: 'blockMath', attrs: { latex } }], next: index + 1 }
  }
  if (line !== '$$') return null
  const body = []
  let cursor = index + 1
  while (cursor < lines.length && lines[cursor].trim() !== '$$') { body.push(lines[cursor]); cursor += 1 }
  if (cursor >= lines.length) {
    warn(warnings, 'unclosed-math', 'An unclosed $$ block was kept as text.')
    return { blocks: paragraphFromLines([lines[index]], warnings), next: index + 1 }
  }
  const latex = body.join('\n').trim()
  if (!latex) {
    warn(warnings, 'empty-math', 'An empty $$ block was kept as text.')
    return { blocks: paragraphFromLines(lines.slice(index, cursor + 1), warnings), next: cursor + 1 }
  }
  return { blocks: [{ type: 'blockMath', attrs: { latex } }], next: cursor + 1 }
}

function parseIndentedCode(lines, index) {
  if (!/^ {4}\S/.test(lines[index]) && !/^\t\S/.test(lines[index])) return null
  const body = []
  let cursor = index
  while (cursor < lines.length) {
    if (isBlank(lines[cursor])) {
      let look = cursor + 1
      while (look < lines.length && isBlank(lines[look])) look += 1
      if (look < lines.length && (/^ {4}/.test(lines[look]) || /^\t/.test(lines[look]))) {
        body.push('')
        cursor += 1
        continue
      }
      break
    }
    if (!/^ {4}/.test(lines[cursor]) && !/^\t/.test(lines[cursor])) break
    body.push(lines[cursor].replace(/^(?: {4}|\t)/, ''))
    cursor += 1
  }
  const text = body.join('\n')
  return { blocks: [withContent('codeBlock', text ? [textNode(text)] : [])], next: cursor }
}

function startsBlock(lines, index) {
  const line = lines[index]
  if (line === undefined || isBlank(line)) return false
  if (fenceAt(line) || atxHeading(line) || isHr(line) || /^ {0,3}>/.test(line) || isHtmlStart(line)) return true
  const marker = listMarker(line)
  if (marker && marker.indent < 4) return true
  if (line.trim() === '$$' || /^\$\$[^$\n]+\$\$$/.test(line.trim())) return true
  if (lines[index + 1] && lines[index].includes('|') && isDelimiterRow(lines[index + 1])) return true
  return false
}

function parseParagraph(lines, index, warnings) {
  const buf = []
  let cursor = index
  while (cursor < lines.length && !isBlank(lines[cursor])) {
    if (buf.length && isSetext(lines[cursor])) {
      const level = lines[cursor].trim().startsWith('=') ? 1 : 2
      const content = parseInlines(buf.join(' ').trim(), [], warnings, 'text')
      return { blocks: [withContent('heading', content, { level })], next: cursor + 1 }
    }
    if (buf.length && startsBlock(lines, cursor)) break
    buf.push(lines[cursor])
    cursor += 1
  }
  return { blocks: paragraphFromLines(buf, warnings), next: cursor }
}

function parseBlock(lines, index, warnings) {
  return parseFence(lines, index, warnings)
    ?? parseMathBlock(lines, index, warnings)
    ?? (atxHeading(lines[index]) && (() => {
      const heading = atxHeading(lines[index])
      const content = parseInlines(heading.text, [], warnings, 'text')
      return { blocks: [withContent('heading', content, { level: heading.level })], next: index + 1 }
    })())
    ?? (isHr(lines[index]) ? { blocks: [{ type: 'horizontalRule' }], next: index + 1 } : null)
    ?? parseQuote(lines, index, warnings)
    ?? parseList(lines, index, warnings)
    ?? parseTable(lines, index, warnings)
    ?? parseHtml(lines, index, warnings)
    ?? parseIndentedCode(lines, index)
    ?? parseParagraph(lines, index, warnings)
}

function parseBlocks(source, warnings) {
  const normalized = source.replace(/\r\n?/g, '\n')
  const lines = normalized.split('\n')
  if (lines.length && lines[lines.length - 1] === '') lines.pop()
  const blocks = []
  let index = 0
  while (index < lines.length) {
    if (isBlank(lines[index])) { index += 1; continue }
    const step = parseBlock(lines, index, warnings)
    if (!step || step.next <= index) fail('CONVERT', 'Markdown parser did not advance. This is a converter bug.')
    blocks.push(...step.blocks)
    index = step.next
  }
  return blocks
}

function finishTitle(blocks, title) {
  const heading = { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: title }] }
  if (blocks[0]?.type === 'heading' && blocks[0].attrs?.level === 1) blocks[0] = heading
  else blocks.unshift(heading)
}

function normalizeInput(markdown) {
  if (typeof markdown !== 'string') fail('ARGUMENT', 'markdown must be a string.')
  return markdown.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
}

/** Blocks to insert into an existing note. Frontmatter is refused. */
export function parseFragment(markdown) {
  const text = normalizeInput(markdown)
  if (!text.trim()) fail('ARGUMENT', 'markdown is empty.')
  const warnings = []
  const frontmatter = splitFrontmatter(text, warnings)
  if (frontmatter.frontmatter) {
    fail('FRONTMATTER', 'insert-markdown and replace-block do not apply YAML frontmatter. Use import to create a note, or remove the leading --- block.')
  }
  const blocks = parseBlocks(normalizeLatexMathDelimiters(frontmatter.body), warnings)
  if (!blocks.length) fail('ARGUMENT', 'markdown produced no blocks.')
  return { blocks, warnings }
}

/**
 * Build a new Stride note file from Markdown.
 * `options.title` / `options.type` override frontmatter. `options.fallbackTitle`
 * is used only when the note has no H1 and no frontmatter title (the file stem).
 */
export function buildNote(markdown, options = {}) {
  const text = normalizeInput(markdown ?? '')
  const warnings = []
  const frontmatter = splitFrontmatter(text, warnings)
  let blocks = parseBlocks(normalizeLatexMathDelimiters(frontmatter.body), warnings)
  let title = ''
  let titleSource = 'missing'
  const leading = blocks[0]?.type === 'heading' && blocks[0].attrs?.level === 1 ? visibleTitle(blocks[0]) : ''
  if (options.title !== undefined) {
    if (typeof options.title !== 'string' || !options.title.trim()) fail('ARGUMENT', '--title must be a nonempty string.')
    title = options.title.trim()
    titleSource = 'option'
    if (leading !== title) {
      if (leading) warn(warnings, 'title-replaced', 'The leading H1 was replaced by --title.')
      finishTitle(blocks, title)
    }
  } else if (leading) {
    title = leading
    titleSource = 'h1'
    if (frontmatter.title && frontmatter.title !== leading) {
      warn(warnings, 'title-mismatch', 'Frontmatter title differs from the leading H1. The H1 is the note title.')
    }
  } else if (frontmatter.title) {
    title = frontmatter.title
    titleSource = 'frontmatter'
    finishTitle(blocks, title)
  } else if (typeof options.fallbackTitle === 'string' && options.fallbackTitle.trim()) {
    title = options.fallbackTitle.trim()
    titleSource = 'filename'
    finishTitle(blocks, title)
  }
  if (options.type !== undefined && (typeof options.type !== 'string' || !options.type.trim())) {
    fail('ARGUMENT', '--type must be a nonempty string.')
  }
  let type = 'note'
  let typeSource = 'default'
  if (typeof options.type === 'string' && options.type.trim()) {
    type = options.type.trim()
    typeSource = 'option'
    if (frontmatter.type && frontmatter.type !== type) warn(warnings, 'type-replaced', 'Frontmatter type was replaced by --type.')
  } else if (frontmatter.type) {
    type = frontmatter.type
    typeSource = 'frontmatter'
  }
  if (!blocks.length || blocks[blocks.length - 1].type !== 'paragraph') blocks.push({ type: 'paragraph' })
  const document = { format: 'tiptap', title, type, properties: frontmatter.properties, doc: { type: 'doc', content: blocks } }
  validateDocument(document)
  return { document, warnings, titleSource, typeSource }
}
