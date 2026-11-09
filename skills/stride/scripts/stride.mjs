#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { fail, object, describe, indexNodes, editDocument, validateDocument } from './lib/document.mjs'
import { buildNote } from './lib/markdown.mjs'
import { rootPath, load, scan, withLock, save, hash, verifyCatalog, newNotePath, createNote } from './lib/vault.mjs'
import { catalog, editRelation, listRelations } from './lib/relations.mjs'

const help = `Stride portable skill CLI — Node.js 18+, no npm dependencies.

node scripts/stride.mjs <command> --vault /absolute/vault [options]

list                         List note IDs and titles
read --note ID               Read document, revision and node refs (b0, b1.0, ...)
convert --from FILE          Print a new note JSON for Markdown. No vault write.
import --note ID --from FILE Create that note from Markdown. Never overwrites.
replace-text --block REF --old TEXT --new TEXT
insert [--before REF | --after REF] --text TEXT | --text-file FILE
insert-markdown [--before REF | --after REF] --markdown TEXT | --markdown-file FILE
replace-block --block REF --markdown TEXT | --markdown-file FILE [--allow-rich-delete]
delete-block --block REF [--allow-rich-delete]
relations list --note ID
relations add|remove --kind belongs_to|related_to --target EXACT_ID
apply --operations FILE      JSON operations array; use - for stdin

convert does not take --vault. import creates a file and does not take --revision.
Other writes require --note ID --revision HASH. --dry-run previews without writing.
insert stores literal text and does not parse Markdown. Use insert-markdown for formatted blocks.
All operations in apply refer to nodes from the original read, even after insertion/deletion.
Outputs JSON; errors are JSON on stderr with exit code 1. See references/cli.md.
`

const operationKeys = {
  'replace-text': ['op', 'block', 'old', 'new'],
  insert: ['op', 'before', 'after', 'text'],
  'insert-markdown': ['op', 'before', 'after', 'markdown'],
  'replace-block': ['op', 'block', 'markdown', 'allowRichDelete'],
  'delete-block': ['op', 'block', 'allowRichDelete'],
  'relation-add': ['op', 'kind', 'target'],
  'relation-remove': ['op', 'kind', 'target'],
}

function checkOperations(ops) {
  if (!Array.isArray(ops) || !ops.length) fail('ARGUMENT', 'operations must be a nonempty JSON array.')
  for (const op of ops) {
    if (!object(op) || !Object.hasOwn(operationKeys, op.op)) fail('ARGUMENT', 'Unknown operation.')
    for (const key of Object.keys(op)) if (!operationKeys[op.op].includes(key)) fail('ARGUMENT', `Unknown operation field ${key}.`)
    if (op.allowRichDelete !== undefined && typeof op.allowRichDelete !== 'boolean') fail('ARGUMENT', 'allowRichDelete must be boolean.')
  }
}

function parse(argv) {
  if (!argv.length || (argv.length === 1 && ['--help', '-h'].includes(argv[0]))) return null
  const command = argv.shift()
  const action = command === 'relations' ? argv.shift() : undefined
  const common = ['vault', 'note']
  const write = ['revision', 'dry-run']
  const flagsByCommand = {
    list: ['vault'], read: common,
    convert: ['from', 'title', 'type'],
    import: ['vault', 'note', 'from', 'title', 'type', 'dry-run'],
    'replace-text': [...common, ...write, 'block', 'old', 'new'],
    insert: [...common, ...write, 'before', 'after', 'text', 'text-file'],
    'insert-markdown': [...common, ...write, 'before', 'after', 'markdown', 'markdown-file'],
    'replace-block': [...common, ...write, 'block', 'markdown', 'markdown-file', 'allow-rich-delete'],
    'delete-block': [...common, ...write, 'block', 'allow-rich-delete'],
    apply: [...common, ...write, 'operations'],
    relations: action === 'list' ? common : [...common, ...write, 'kind', 'target'],
  }
  if (!Object.hasOwn(flagsByCommand, command) || (command === 'relations' && !['list', 'add', 'remove'].includes(action))) {
    fail('ARGUMENT', 'Unknown command. Run with --help.')
  }
  const flags = Object.create(null)
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const key = arg.slice(2)
    if (!arg.startsWith('--') || !flagsByCommand[command].includes(key) || Object.hasOwn(flags, key)) fail('ARGUMENT', `Unknown or duplicate option ${arg}.`)
    if (['dry-run', 'allow-rich-delete'].includes(key)) flags[key] = true
    else {
      if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) fail('ARGUMENT', `Missing value for ${arg}. For literal text beginning with --, use apply JSON or --text-file.`)
      flags[key] = argv[++i]
    }
  }
  return { command, action, flags }
}

function inputFile(path) {
  if (typeof path !== 'string' || !path) fail('ARGUMENT', 'An input file is required.')
  return readFileSync(path === '-' ? 0 : path, 'utf8')
}

function markdownSource(flags, fileKey, textKey) {
  const file = flags[fileKey]
  const text = flags[textKey]
  if ((text === undefined) === (file === undefined)) {
    fail('ARGUMENT', `Provide exactly one of --${textKey} or --${fileKey}.`)
  }
  return text ?? inputFile(file)
}

function noteFromMarkdown(markdown, flags, fallbackTitle) {
  return buildNote(markdown, { title: flags.title, type: flags.type, fallbackTitle })
}

function main(argv) {
  const args = parse(argv)
  if (!args) { process.stdout.write(help); return }
  const { command, action, flags: f } = args
  if (command === 'convert') {
    if (!f.from) fail('ARGUMENT', '--from is required.')
    const built = noteFromMarkdown(inputFile(f.from), f)
    return { document: built.document, warnings: built.warnings, titleSource: built.titleSource, typeSource: built.typeSource }
  }
  const root = rootPath(f.vault)
  if (command === 'import') {
    if (!f.note || !f.from) fail('ARGUMENT', '--note and --from are required.')
    const built = noteFromMarkdown(inputFile(f.from), f, f.note.split('/').pop())
    const payload = { warnings: built.warnings, titleSource: built.titleSource, typeSource: built.typeSource, document: built.document }
    if (f['dry-run']) {
      newNotePath(root, f.note)
      return { dryRun: true, id: f.note, changed: true, ...payload }
    }
    return { ...createNote(root, f.note, built.document), ...payload }
  }
  if (command === 'list') return catalog(scan(root)).map((n) => ({ id: n.id, title: n.title, type: n.file.type, revision: n.revision }))
  const original = load(root, f.note)
  if (command === 'read') return describe(original.id, original.revision, original.file)
  if (command === 'relations' && action === 'list') return { ...listRelations(catalog(scan(root)), original.id), revision: original.revision }
  if (!f.revision || f.revision !== original.revision) fail('REVISION_CONFLICT', 'A matching --revision from read is required. Read again before editing.')
  let ops
  if (command === 'apply') {
    try { ops = JSON.parse(inputFile(f.operations)) } catch (error) {
      if (error instanceof SyntaxError) fail('ARGUMENT', 'operations file must contain valid JSON.')
      throw error
    }
  } else if (command === 'replace-text') ops = [{ op: command, block: f.block, old: f.old, new: f.new }]
  else if (command === 'delete-block') ops = [{ op: command, block: f.block, allowRichDelete: f['allow-rich-delete'] }]
  else if (command === 'insert') {
    if ((f.text === undefined) === (f['text-file'] === undefined)) fail('ARGUMENT', 'Provide exactly one of --text or --text-file.')
    ops = [{ op: command, before: f.before, after: f.after, text: f.text ?? inputFile(f['text-file']) }]
  } else if (command === 'insert-markdown') {
    ops = [{ op: command, before: f.before, after: f.after, markdown: markdownSource(f, 'markdown-file', 'markdown') }]
  } else if (command === 'replace-block') {
    ops = [{
      op: command, block: f.block, markdown: markdownSource(f, 'markdown-file', 'markdown'),
      ...(f['allow-rich-delete'] ? { allowRichDelete: true } : {}),
    }]
  } else ops = [{ op: `relation-${action}`, kind: f.kind, target: f.target }]
  checkOperations(ops)
  const mutate = () => {
    const entries = ops.some((op) => op.op.startsWith('relation-')) ? scan(root) : null
    const notes = entries ? catalog(entries) : null
    const file = structuredClone(original.file)
    const refs = indexNodes(file.doc)
    const warnings = []
    for (const op of ops) {
      if (op.op.startsWith('relation-')) editRelation(file, original.id, notes, op)
      else warnings.push(...editDocument(file, refs, op))
    }
    validateDocument(file)
    const verify = () => {
      if (load(root, original.id).revision !== original.revision) fail('REVISION_CONFLICT', 'Source changed during editing. Read again.')
      if (entries) verifyCatalog(root, entries)
    }
    verify()
    const markdownEdit = ops.some((op) => op.op === 'insert-markdown' || op.op === 'replace-block')
    const described = (revision) => ({ ...describe(original.id, revision, file), ...(markdownEdit ? { warnings } : {}) })
    if (f['dry-run']) {
      return { dryRun: true, changed: JSON.stringify(file) !== JSON.stringify(original.file),
        baseRevision: original.revision, preview: described(hash(JSON.stringify(file, null, 2) + '\n')) }
    }
    const result = save(root, original, file, verify)
    return { ...result, ...described(result.revision) }
  }
  return f['dry-run'] ? mutate() : withLock(original.path, mutate)
}

try {
  const result = main(process.argv.slice(2))
  if (result !== undefined) process.stdout.write(JSON.stringify(result, null, 2) + '\n')
} catch (error) {
  process.stderr.write(JSON.stringify({ error: { code: error.code ?? 'ERROR', message: error.message } }) + '\n')
  process.exitCode = 1
}
