#!/usr/bin/env node
// Drive the portable Stride skill against e2e/stride, a real vault.
// Usage from the repo root: node e2e/check-skill.mjs
// The script only talks to skills/stride/scripts/stride.mjs. It does not import Stride source.

import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const here = dirname(fileURLToPath(import.meta.url))
const repo = dirname(here)
const vault = join(here, 'stride')
const fixtures = join(here, 'fixtures')
const script = join(repo, 'skills/stride/scripts/stride.mjs')
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

function filesUnder(dir) {
  const found = []
  const walk = (current) => {
    for (const name of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, name.name)
      if (name.isDirectory()) walk(path)
      else found.push(relative(dir, path))
    }
  }
  try { walk(dir) } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  return found.sort()
}

function cli(args, { status = 0, cwd = repo, input } = {}) {
  const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', cwd, input })
  assert.equal(result.status, status, result.stderr || result.stdout || `exit ${result.status}`)
  const raw = status === 0 ? result.stdout : result.stderr
  return JSON.parse(raw)
}

function notePath(id) {
  return join(vault, `${id}.stride.json`)
}

function disk(id) {
  return JSON.parse(readFileSync(notePath(id), 'utf8'))
}

function raw(id) {
  return readFileSync(notePath(id))
}

function read(id) {
  return cli(['read', '--vault', vault, '--note', id])
}

function write(id, revision, args, options) {
  return cli([args[0], '--vault', vault, '--note', id, '--revision', revision, ...args.slice(1)], options)
}

function nodesOf(doc, type) {
  const found = []
  const walk = (node) => {
    if (node?.type === type) found.push(node)
    node?.content?.forEach(walk)
  }
  walk(doc)
  return found
}

function textOf(node) {
  if (!node) return ''
  if (node.type === 'text') return node.text ?? ''
  if (node.type === 'hardBreak') return '\n'
  return (node.content ?? []).map(textOf).join('')
}

function topBlock(doc, type, includes) {
  return doc.content.find((node) => node.type === type && textOf(node).includes(includes))
}

function resetVault() {
  rmSync(vault, { recursive: true, force: true })
  mkdirSync(join(vault, '.stride'), { recursive: true })
  mkdirSync(join(vault, 'attachments'), { recursive: true })
  writeFileSync(
    join(vault, '.stride', 'vault.json'),
    `${JSON.stringify({ kind: 'stride-vault', version: 1 }, null, 2)}\n`,
  )
  writeFileSync(join(vault, 'attachments', 'figure.png'), png)
  mkdirSync(dirname(notePath('notes/field-log')), { recursive: true })
  writeFileSync(notePath('notes/field-log'), `${JSON.stringify({
    format: 'tiptap',
    title: '现场记录',
    type: 'note',
    properties: { status: 'draft' },
    futureMetadata: { keep: true },
    doc: {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: '现场记录' }] },
        {
          type: 'paragraph',
          attrs: { custom: 7 },
          content: [
            { type: 'text', text: '周五发布', marks: [{ type: 'bold' }] },
            { type: 'text', text: '，请关注。' },
          ],
        },
        { type: 'paragraph', content: [{ type: 'text', text: '旧段落' }] },
        { type: 'futureWidget', attrs: { payload: ['untouched'] } },
      ],
    },
  }, null, 2)}\n`)
}

function expectImportedLibrary() {
  const before = filesUnder(vault)
  const rejected = cli(['convert', '--from', join(fixtures, 'alpha.md'), '--vault', vault], { status: 1 })
  assert.equal(rejected.error.code, 'ARGUMENT')
  assert.deepEqual(filesUnder(vault), before)

  const converted = cli(['convert', '--from', join(fixtures, 'alpha.md')])
  assert.equal(converted.document.title, 'Alpha')
  assert.equal(converted.titleSource, 'h1')
  assert.deepEqual(filesUnder(vault), before)

  const preview = cli([
    'import', '--vault', vault, '--note', 'notes/preview', '--from', join(fixtures, 'team.md'), '--dry-run',
  ])
  assert.equal(preview.dryRun, true)
  assert.equal(filesUnder(vault).includes('notes/preview.stride.json'), false)

  cli(['import', '--vault', vault, '--note', 'types/project', '--from', join(fixtures, 'project-type.md'), '--type', 'Type'])
  cli(['import', '--vault', vault, '--note', 'projects/team', '--from', join(fixtures, 'team.md')])
  const alpha = cli(['import', '--vault', vault, '--note', 'projects/alpha', '--from', join(fixtures, 'alpha.md')])
  const again = cli([
    'import', '--vault', vault, '--note', 'projects/alpha', '--from', join(fixtures, 'alpha.md'),
  ], { status: 1 })
  assert.equal(again.error.code, 'EXISTS')
  assert.equal(raw('projects/alpha').equals(Buffer.from(JSON.stringify(alpha.document, null, 2) + '\n')), true)

  const edges = cli(['import', '--vault', vault, '--note', 'notes/edges', '--from', join(fixtures, 'edges.md')])
  return { alpha, edges }
}

function expectAlphaShape(created) {
  const file = disk('projects/alpha')
  assert.deepEqual(file, created.document)
  assert.equal(file.format, 'tiptap')
  assert.equal(file.title, 'Alpha')
  assert.equal(file.type, '项目')
  assert.equal(file.properties.title, undefined)
  assert.equal(file.properties.type, undefined)
  assert.equal(file.properties.status, 'draft')
  assert.equal(file.properties.owner, 'Ada')
  assert.deepEqual(file.properties.tags, ['launch', 'vault'])
  assert.equal(file.doc.content[0].type, 'heading')
  assert.equal(file.doc.content[0].attrs.level, 1)
  assert.equal(textOf(file.doc.content[0]), 'Alpha')

  const bold = nodesOf(file.doc, 'text').find((node) => node.text === '发布')
  assert.deepEqual(bold.marks, [{ type: 'bold' }])
  const link = nodesOf(file.doc, 'wikilink')
  assert.equal(link.length, 1)
  assert.equal(link[0].attrs.target, '团队')
  assert.equal(link[0].attrs.alias, undefined)

  const bullets = nodesOf(file.doc, 'bulletList')
  assert.equal(bullets.length, 1)
  assert.equal(bullets[0].content.length, 2)
  const ordered = nodesOf(file.doc, 'orderedList')
  assert.equal(ordered.length, 1)
  assert.equal(ordered[0].content.length, 2)
  assert.equal(ordered[0].attrs, undefined)
  const tasks = nodesOf(file.doc, 'taskItem')
  assert.deepEqual(tasks.map((node) => node.attrs.checked), [false, true])
  assert.equal(nodesOf(file.doc, 'callout')[0].attrs.kind, 'warning')
  assert.equal(nodesOf(file.doc, 'table').length, 1)
  assert.equal(nodesOf(file.doc, 'tableHeader')[0].content[0].content[0].text, '项')
  assert.equal(nodesOf(file.doc, 'codeBlock')[0].attrs.language, 'ts')
  assert.equal(textOf(nodesOf(file.doc, 'codeBlock')[0]), 'const ok = true')
  assert.equal(nodesOf(file.doc, 'mermaid')[0].attrs.view, 'render')
  assert.match(nodesOf(file.doc, 'blockMath')[0].attrs.latex, /E = mc\^2/)
  assert.equal(nodesOf(file.doc, 'inlineMath')[0].attrs.latex, 'a^2')
  assert.equal(nodesOf(file.doc, 'text').find((node) => node.text === '重点').marks[0].type, 'highlight')
  assert.equal(nodesOf(file.doc, 'image').length, 1)
  assert.deepEqual(nodesOf(file.doc, 'image')[0].attrs, { src: 'attachments/figure.png', alt: '示意图' })
  const oldDraft = nodesOf(file.doc, 'text').find((node) => node.text === '旧稿')
  assert.equal(oldDraft.marks[0].attrs.href, './old.md')
  assert.equal(created.warnings.some((warning) => warning.code === 'image-kept'), true)
  assert.match(JSON.stringify(file), /!\[本地图\]\(\.\/local\.png\)/)
  assert.equal(JSON.stringify(file).includes('\uE000'), false)
  assert.equal(disk('types/project').type, 'Type')
  assert.equal(disk('types/project').title, '项目')
  assert.equal(disk('projects/team').title, '团队')
}

function expectEdges(created) {
  const file = disk('notes/edges')
  assert.equal(file.title, '边界')
  assert.equal(file.properties.meta, '{"a":1,"b":{"c":2}}')
  assert.equal(file.properties.bio, 'hello  \nworld')
  assert.deepEqual(Object.entries(file.properties).filter(([key]) => key === '__proto__' || key === 'constructor'), [
    ['__proto__', 'hi'],
    ['constructor', 'keep'],
  ])
  const codes = created.warnings.map((warning) => warning.code)
  assert.equal(codes.includes('frontmatter-degraded'), true)
  assert.equal(codes.includes('link-kept'), true)
  assert.equal(codes.includes('image-inline'), true)
  assert.equal(codes.includes('image-kept'), false)
  const texts = nodesOf(file.doc, 'text').map((node) => node.text)
  assert.equal(texts.includes('code\\ more'), true)
  assert.equal(texts.some((text) => /code {2}/.test(text)), true)
  assert.equal(texts.includes('https://example.com/go'), true)
  assert.equal(nodesOf(file.doc, 'inlineMath').some((node) => node.attrs.latex === 'E=mc^2'), true)
  assert.equal(texts.some((text) => text.includes('$5 and $10')), true)
  assert.equal(nodesOf(file.doc, 'inlineMath').some((node) => String(node.attrs.latex).includes('5 and')), false)
  assert.match(JSON.stringify(file), /example\.com\/a/)
  assert.equal(JSON.stringify(file).includes('\uE000'), false)
  assert.equal(nodesOf(file.doc, 'image').length, 0)
  const heading = file.doc.content.find((node) => node.type === 'heading' && node.attrs.level === 2)
  assert.match(textOf(heading), /!\[x\]\(\.\/local\.png\)/)
}

function expectFieldLogEdits() {
  const original = raw('notes/field-log')
  let current = read('notes/field-log')
  const release = current.blocks.find((block) => block.type === 'text' && block.text === '周五发布')
  const preview = write('notes/field-log', current.revision, [
    'replace-text', '--block', release.ref, '--old', '发布', '--new', '上线', '--dry-run',
  ])
  assert.equal(preview.dryRun, true)
  assert.equal(raw('notes/field-log').equals(original), true)

  const replaced = write('notes/field-log', current.revision, [
    'replace-text', '--block', release.ref, '--old', '发布', '--new', '上线',
  ])
  const stale = write('notes/field-log', current.revision, [
    'replace-text', '--block', release.ref, '--old', '上线', '--new', '延期',
  ], { status: 1 })
  assert.equal(stale.error.code, 'REVISION_CONFLICT')
  const edited = disk('notes/field-log')
  const updated = nodesOf(edited.doc, 'text').find((node) => node.text === '周五上线')
  assert.deepEqual(updated.marks, [{ type: 'bold' }])
  assert.equal(topBlock(edited.doc, 'paragraph', '周五上线').attrs.custom, 7)
  assert.deepEqual(edited.futureMetadata, { keep: true })
  assert.equal(edited.doc.content.some((node) => node.type === 'futureWidget'), true)
  assert.equal(replaced.revision, read('notes/field-log').revision)

  current = read('notes/field-log')
  const title = current.blocks.find((block) => block.ref === 'b0')
  const protectedTitle = write('notes/field-log', current.revision, [
    'replace-text', '--block', title.ref, '--old', '现场记录', '--new', '改名',
  ], { status: 1 })
  assert.equal(protectedTitle.error.code, 'TITLE_PROTECTED')
  write('notes/field-log', current.revision, [
    'insert', '--after', 'b1', '--text', '**不是加粗**\n第二行',
  ])
  current = read('notes/field-log')
  const literal = disk('notes/field-log').doc.content[2]
  assert.equal(literal.type, 'paragraph')
  assert.equal(literal.content[0].text, '**不是加粗**')
  assert.equal(literal.content[0].marks, undefined)
  assert.equal(literal.content[1].type, 'hardBreak')
  assert.equal(literal.content[2].text, '第二行')

  const anchor = current.blocks.find((block) => block.text === '**不是加粗**\n第二行' && block.type === 'paragraph')
  write('notes/field-log', current.revision, [
    'insert-markdown', '--after', anchor.ref, '--markdown', '## 进展\n\n- **已完成**迁移',
  ])
  current = read('notes/field-log')
  const inserted = disk('notes/field-log')
  assert.equal(inserted.doc.content[3].type, 'heading')
  assert.equal(inserted.doc.content[3].attrs.level, 2)
  assert.equal(textOf(inserted.doc.content[3]), '进展')
  assert.equal(inserted.doc.content[4].type, 'bulletList')
  assert.deepEqual(
    nodesOf(inserted.doc.content[4], 'text').find((node) => node.text === '已完成').marks,
    [{ type: 'bold' }],
  )
  const staleParagraph = current.blocks.find((block) => block.type === 'paragraph' && block.text === '旧段落')
  write('notes/field-log', current.revision, ['delete-block', '--block', staleParagraph.ref])
  const afterDelete = disk('notes/field-log')
  assert.equal(textOf(afterDelete.doc).includes('旧段落'), false)
  assert.equal(afterDelete.doc.content.at(-1).type, 'futureWidget')
  assert.deepEqual(afterDelete.doc.content.at(-1).attrs, { payload: ['untouched'] })

  current = read('notes/field-log')
  const widget = current.blocks.find((block) => block.type === 'futureWidget')
  const beforeRefuse = raw('notes/field-log')
  const refused = write('notes/field-log', current.revision, [
    'delete-block', '--block', widget.ref,
  ], { status: 1 })
  assert.equal(refused.error.code, 'RICH_CONTENT')
  const frontmatter = write('notes/field-log', current.revision, [
    'insert-markdown', '--markdown-file', join(fixtures, 'frontmatter.md'),
  ], { status: 1 })
  assert.equal(frontmatter.error.code, 'FRONTMATTER')
  assert.equal(raw('notes/field-log').equals(beforeRefuse), true)
  assert.equal(disk('notes/field-log').title, '现场记录')
}

function expectAlphaEdits() {
  let current = read('projects/alpha')
  const release = current.blocks.find((block) => block.type === 'text' && block.text === '发布')
  write('projects/alpha', current.revision, [
    'replace-text', '--block', release.ref, '--old', '发布', '--new', '上线',
  ])
  let file = disk('projects/alpha')
  assert.deepEqual(nodesOf(file.doc, 'text').find((node) => node.text === '上线').marks, [{ type: 'bold' }])
  assert.equal(nodesOf(file.doc, 'wikilink')[0].attrs.target, '团队')
  assert.equal(file.type, '项目')
  assert.deepEqual(file.properties.tags, ['launch', 'vault'])

  current = read('projects/alpha')
  cli([
    'relations', 'add', '--vault', vault, '--note', 'projects/alpha', '--revision', current.revision,
    '--kind', 'belongs_to', '--target', 'projects/team',
  ])
  file = disk('projects/alpha')
  assert.deepEqual(file.properties.belongs_to, ['[[团队]]'])
  const fromTeam = cli(['relations', 'list', '--vault', vault, '--note', 'projects/team'])
  assert.equal(fromTeam.backlinks.some((link) => link.sourceId === 'projects/alpha' && link.via === 'belongs_to'), true)
  assert.equal(fromTeam.backlinks.some((link) => link.sourceId === 'projects/alpha' && link.via === 'body'), true)
  assert.equal(fromTeam.derived.some((link) => link.field === 'has' && link.targetId === 'projects/alpha'), true)
  assert.equal(disk('projects/team').properties.belongs_to, undefined)

  current = read('projects/alpha')
  const operations = join(tmpdir(), `stride-e2e-ops-${process.pid}.json`)
  writeFileSync(operations, JSON.stringify([
    { op: 'insert-markdown', markdown: '## 进展\n\n- **已完成**核对' },
    { op: 'relation-add', kind: 'related_to', target: 'projects/team' },
  ]))
  const applied = write('projects/alpha', current.revision, ['apply', '--operations', operations])
  assert.equal(applied.warnings.some((warning) => warning.code), false)
  file = disk('projects/alpha')
  assert.equal(file.doc.content.at(-2).type, 'heading')
  assert.equal(textOf(file.doc.content.at(-2)), '进展')
  assert.equal(file.doc.content.at(-1).type, 'bulletList')
  assert.deepEqual(file.properties.related_to, ['[[团队]]'])
  assert.deepEqual(file.properties.belongs_to, ['[[团队]]'])

  current = read('projects/alpha')
  const linkParagraph = current.blocks.find((block) => block.type === 'paragraph' && block.text.includes('旧稿'))
  const table = current.blocks.find((block) => block.type === 'table' && !block.ref.includes('.'))
  const beforeRich = raw('projects/alpha')
  const rich = write('projects/alpha', current.revision, [
    'replace-block', '--block', table.ref, '--markdown', '表格不该消失',
  ], { status: 1 })
  assert.equal(rich.error.code, 'RICH_CONTENT')
  assert.equal(raw('projects/alpha').equals(beforeRich), true)
  write('projects/alpha', current.revision, [
    'replace-block', '--block', linkParagraph.ref, '--markdown', '替换后的说明。',
  ])
  file = disk('projects/alpha')
  assert.equal(nodesOf(file.doc, 'text').some((node) => node.text === '旧稿'), false)
  assert.equal(nodesOf(file.doc, 'text').some((node) => node.text === '替换后的说明。'), true)
  assert.equal(nodesOf(file.doc, 'table').length, 1)

  current = read('projects/alpha')
  const image = current.blocks.find((block) => block.type === 'image')
  write('projects/alpha', current.revision, [
    'replace-block', '--block', image.ref, '--markdown', '图片已按要求换成这段说明。', '--allow-rich-delete',
  ])
  file = disk('projects/alpha')
  assert.equal(nodesOf(file.doc, 'image').length, 0)
  assert.equal(nodesOf(file.doc, 'text').some((node) => node.text === '图片已按要求换成这段说明。'), true)
  assert.equal(nodesOf(file.doc, 'codeBlock').length, 1)
  assert.equal(nodesOf(file.doc, 'mermaid').length, 1)
}

function expectVaultCloses() {
  const listed = cli(['list', '--vault', vault], { cwd: vault })
  const ids = listed.map((note) => note.id).sort()
  assert.deepEqual(ids, [
    'notes/edges',
    'notes/field-log',
    'projects/alpha',
    'projects/team',
    'types/project',
  ])
  for (const id of ids) {
    const file = disk(id)
    assert.equal(file.format, 'tiptap', id)
    assert.equal(file.doc.type, 'doc', id)
    assert.equal(JSON.stringify(file).includes('\uE000'), false, id)
    assert.equal(raw(id).subarray(-1).toString(), '\n', id)
    const described = read(id)
    assert.equal(described.document.title, file.title)
    assert.match(described.revision, /^[a-f0-9]{64}$/)
  }
  const marker = JSON.parse(readFileSync(join(vault, '.stride', 'vault.json'), 'utf8'))
  assert.equal(marker.kind, 'stride-vault')
  console.log(`通过。Vault 在 ${relative(repo, vault)}`)
  for (const note of listed) console.log(`- ${note.id}  ${note.title}  (${note.type})`)
}

resetVault()
const created = expectImportedLibrary()
expectAlphaShape(created.alpha)
expectEdges(created.edges)
expectFieldLogEdits()
expectAlphaEdits()
expectVaultCloses()
