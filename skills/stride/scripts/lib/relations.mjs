import { effectiveTitle, fail } from './document.mjs'

const normalized = (value) => value.trim().toLowerCase()
const fieldKind = (value) => normalized(value).replace(/\s+/g, ' ').replace(' ', '_')

function tokens(value) {
  if (Array.isArray(value)) return value.flatMap(tokens)
  if (typeof value !== 'string') return []
  return [...value.matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => ({
    token: m[0], target: m[1].split('|')[0].trim(),
  })).filter((item) => item.target)
}

export function catalog(entries) {
  return entries.map((entry) => ({ ...entry, title: effectiveTitle(entry.file, entry.id) }))
}

function resolve(notes, ref) {
  const key = normalized(ref)
  for (const match of [
    notes.filter((n) => n.title.toLowerCase() === key),
    notes.filter((n) => n.id.toLowerCase() === key),
    notes.filter((n) => n.id.toLowerCase() === key.replace(/\s+/g, '-')),
  ]) {
    if (match.length) return match
  }
  return []
}

function targetId(notes, ref) {
  const matches = resolve(notes, ref)
  if (matches.length > 1) fail('AMBIGUOUS_LINK', `Ambiguous link [[${ref}]]: ${matches.map((n) => n.id).join(', ')}`)
  return matches[0]?.id
}

function referenceFor(notes, target) {
  for (const ref of [target.title, target.id]) {
    if (!ref || /[\[\]|\r\n]/.test(ref)) continue
    const matches = resolve(notes, ref)
    if (matches.length === 1 && matches[0].id === target.id) return ref
  }
  fail('AMBIGUOUS_LINK', `Cannot create an unambiguous link to ${target.id}; its title/ID is ambiguous or shadowed.`)
}

export function editRelation(file, sourceId, notes, op) {
  if (!['belongs_to', 'related_to'].includes(op.kind)) fail('ARGUMENT', 'kind must be belongs_to or related_to.')
  const keys = Object.keys(file.properties).filter((key) => fieldKind(key) === op.kind)
  if (keys.length > 1) fail('RELATION_KEYS', `Multiple keys represent ${op.kind}; resolve them before editing.`)
  const field = keys[0] ?? op.kind
  const target = notes.find((note) => note.id === op.target)
  if (!target) fail('TARGET_NOT_FOUND', 'target must be an existing exact note ID from list, without .stride.json.')
  if (sourceId === target.id) fail('SELF_LINK', 'Structural self-links are not supported.')
  const value = file.properties[field]
  if (value !== undefined && typeof value !== 'string' && !Array.isArray(value)) fail('RELATION_VALUE', 'Existing property is not a string/list; it will not be overwritten.')
  if (op.op === 'relation-add') {
    // Validate serialization even if a link already exists: it may now be shadowed.
    const ref = referenceFor(notes, target)
    if (tokens(value).some((token) => targetId(notes, token.target) === target.id)) return
    const token = `[[${ref}]]`
    if (value === undefined || value === '') file.properties[field] = [token]
    else if (Array.isArray(value)) file.properties[field] = [...value, token]
    else file.properties[field] = `${value} ${token}`
    return
  }
  const remove = (text) => text.replace(/\[\[([^\]]+)\]\]/g, (token, inner) =>
    targetId(notes, inner.split('|')[0].trim()) === target.id ? '' : token)
  if (value === undefined) return
  const next = Array.isArray(value) ? value.flatMap((text) => {
    const updated = remove(text)
    return updated === text || updated.trim() ? [updated] : []
  }) : remove(value)
  if (JSON.stringify(next) === JSON.stringify(value)) return
  if (Array.isArray(next) ? next.length : next.trim()) file.properties[field] = next
  else delete file.properties[field]
}

export function listRelations(notes, id) {
  const outgoing = [], backlinks = [], derived = [], body = []
  for (const source of notes) {
    for (const [field, value] of Object.entries(source.file.properties)) {
      for (const token of tokens(value)) {
        const matches = resolve(notes, token.target)
        const resolvedId = matches.length === 1 ? matches[0].id : null
        const link = { field, target: token.target, resolvedId, candidates: matches.map((n) => n.id) }
        if (source.id === id) outgoing.push(link)
        if (resolvedId === id) {
          backlinks.push({ sourceId: source.id, via: field })
          const kind = fieldKind(field)
          if (kind === 'belongs_to' || kind === 'related_to') {
            derived.push({ field: kind === 'belongs_to' ? 'has' : 'related_to', targetId: source.id })
          }
        }
      }
    }
    const walk = (node) => {
      const refs = node.type === 'wikilink' && typeof node.attrs?.target === 'string'
        ? [{ target: node.attrs.target }] : node.type === 'text' ? tokens(node.text) : []
      for (const ref of refs) {
        const matches = resolve(notes, ref.target)
        const resolvedId = matches.length === 1 ? matches[0].id : null
        if (source.id === id) body.push({ target: ref.target, resolvedId, candidates: matches.map((n) => n.id) })
        if (resolvedId === id && source.id !== id) backlinks.push({ sourceId: source.id, via: 'body' })
      }
      node.content?.forEach(walk)
    }
    walk(source.file.doc)
  }
  return { id, outgoing, body, backlinks, derived }
}
