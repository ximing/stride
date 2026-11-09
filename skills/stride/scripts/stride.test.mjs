import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync, cpSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { buildNote } from './lib/markdown.mjs'

const script = fileURLToPath(new URL('./stride.mjs', import.meta.url))
const text = (value, extra = {}) => ({ type: 'text', text: value, ...extra })
const paragraph = (value) => ({ type: 'paragraph', content: [text(value)] })
const document = (title = 'Alpha') => ({
  format: 'tiptap', title, type: 'note', properties: { status: 'draft' }, futureMetadata: { keep: true },
  doc: { type: 'doc', content: [
    { type: 'heading', attrs: { level: 1 }, content: [text(title)] },
    { type: 'paragraph', attrs: { custom: 7 }, content: [text('周五发布', { marks: [{ type: 'bold' }] }), text('，请关注。')] },
    paragraph('旧段落'),
    { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableCell', content: [paragraph('表格内容')] }] }] },
    { type: 'futureWidget', attrs: { payload: ['untouched'] } },
  ] },
})

function fixture(t) {
  const vault = mkdtempSync(join(tmpdir(), 'stride-cli-test-'))
  t.after(() => rmSync(vault, { recursive: true, force: true }))
  const put = (id, doc = document()) => {
    const file = join(vault, `${id}.stride.json`)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(doc, null, 2) + '\n')
    return file
  }
  put('projects/alpha')
  const run = (args, expected = 0, input) => {
    const result = spawnSync(process.execPath, [script, ...args, '--vault', vault], { encoding: 'utf8', input })
    assert.equal(result.status, expected, result.stderr || result.stdout)
    return JSON.parse(expected === 0 ? result.stdout : result.stderr)
  }
  const read = () => run(['read', '--note', 'projects/alpha'])
  const disk = () => JSON.parse(readFileSync(join(vault, 'projects/alpha.stride.json'), 'utf8'))
  const writeArgs = (command, revision = read().revision) => [command, '--note', 'projects/alpha', '--revision', revision]
  return { vault, put, run, read, disk, writeArgs }
}

test('read exposes versioned readable nodes and preserves the complete document', (t) => {
  const f = fixture(t)
  const result = f.read()
  assert.match(result.revision, /^[a-f0-9]{64}$/)
  assert.equal(result.blocks.find((b) => b.ref === 'b1').text, '周五发布，请关注。')
  assert.equal(result.blocks.find((b) => b.ref === 'b3.0.0.0').text, '表格内容')
  assert.deepEqual(result.document, f.disk())
})

test('text replacement preserves formatting, media, unknown nodes and metadata', (t) => {
  const f = fixture(t)
  const before = f.disk()
  f.run([...f.writeArgs('replace-text'), '--block', 'b1', '--old', '周五', '--new', '周一'])
  const expected = structuredClone(before)
  expected.doc.content[1].content[0].text = '周一发布'
  assert.deepEqual(f.disk(), expected)
})

test('dry-run does not write and stale revisions cannot overwrite newer edits', (t) => {
  const f = fixture(t)
  const snapshot = f.read()
  const args = [...f.writeArgs('replace-text', snapshot.revision), '--block', 'b1', '--old', '周五', '--new', '周一']
  const preview = f.run([...args, '--dry-run'])
  assert.equal(preview.dryRun, true)
  assert.deepEqual(f.disk(), snapshot.document)
  const changed = f.disk(); changed.properties.status = 'updated elsewhere'; f.put('projects/alpha', changed)
  assert.equal(f.run(args, 1).error.code, 'REVISION_CONFLICT')
  assert.deepEqual(f.disk(), changed)
})

test('batch refs identify original nodes after insert/delete; failure leaves original bytes intact', (t) => {
  const f = fixture(t)
  const ops = [
    { op: 'insert', after: 'b1', text: '插入的段落' },
    { op: 'delete-block', block: 'b2' },
    { op: 'replace-text', block: 'b1', old: '周五', new: '周一' },
  ]
  f.run([...f.writeArgs('apply'), '--operations', '-'], 0, JSON.stringify(ops))
  assert.equal(f.disk().doc.content[2].content[0].text, '插入的段落')
  assert.equal(f.disk().doc.content[3].type, 'table')
  const before = readFileSync(join(f.vault, 'projects/alpha.stride.json'), 'utf8')
  f.run([...f.writeArgs('apply'), '--operations', '-'], 1, JSON.stringify([
    { op: 'insert', after: 'b1', text: 'should not persist' },
    { op: 'replace-text', block: 'b1', old: '不存在', new: 'x' },
  ]))
  assert.equal(readFileSync(join(f.vault, 'projects/alpha.stride.json'), 'utf8'), before)
})

test('ambiguous and cross-mark replacement, title edits and rich deletion are refused', (t) => {
  const f = fixture(t)
  assert.equal(f.run([...f.writeArgs('replace-text'), '--block', 'b1', '--old', '发布，请', '--new', '新文字'], 1).error.code, 'TEXT_MATCH')
  assert.equal(f.run([...f.writeArgs('replace-text'), '--block', 'b0', '--old', 'Alpha', '--new', 'Beta'], 1).error.code, 'TITLE_PROTECTED')
  assert.equal(f.run([...f.writeArgs('delete-block'), '--block', 'b3'], 1).error.code, 'RICH_CONTENT')
  const changed = f.disk(); changed.doc.content[2] = paragraph('重复 重复'); f.put('projects/alpha', changed)
  assert.equal(f.run([...f.writeArgs('replace-text'), '--block', 'b2', '--old', '重复', '--new', '替换'], 1).error.code, 'TEXT_MATCH')
  f.run([...f.writeArgs('delete-block'), '--block', 'b3', '--allow-rich-delete'])
  assert.equal(f.disk().doc.content[3].type, 'futureWidget')
})

test('inserting literal text and deleting the last cell paragraph keep legal containers', (t) => {
  const f = fixture(t)
  f.run([...f.writeArgs('insert'), '--after', 'b1', '--text', '**literal**\n第二行\n\n另一个段落'])
  assert.equal(f.disk().doc.content[2].content[0].text, '**literal**')
  assert.equal(f.disk().doc.content[2].content[1].type, 'hardBreak')
  const table = f.read().blocks.find((b) => b.type === 'table')
  f.run([...f.writeArgs('delete-block'), '--block', `${table.ref}.0.0.0`])
  assert.deepEqual(f.disk().doc.content[5].content[0].content[0].content, [{ type: 'paragraph' }])
})

test('relations preserve mixed text, aliases, legacy keys and semantic duplicates', (t) => {
  const f = fixture(t)
  f.put('b', document('Beta')); f.put('c', document('Gamma'))
  const d = f.disk(); d.properties['belongs to'] = ['背景 [[Beta|旧项目]]，参考', '[[b]]']; f.put('projects/alpha', d)
  f.run(['relations', 'add', '--note', 'projects/alpha', '--revision', f.read().revision, '--kind', 'belongs_to', '--target', 'b'])
  assert.deepEqual(f.disk(), d)
  f.run([...f.writeArgs('apply'), '--operations', '-'], 0, JSON.stringify([
    { op: 'relation-remove', kind: 'belongs_to', target: 'b' },
    { op: 'relation-add', kind: 'belongs_to', target: 'c' },
  ]))
  assert.deepEqual(f.disk().properties['belongs to'], ['背景 ，参考', '[[Gamma]]'])
  assert.equal(f.disk().properties.belongs_to, undefined)
  const back = f.run(['relations', 'list', '--note', 'c'])
  assert.equal(back.backlinks[0].sourceId, 'projects/alpha')
  assert.equal(back.derived[0].field, 'has')
  assert.deepEqual(JSON.parse(readFileSync(join(f.vault, 'c.stride.json'), 'utf8')), document('Gamma'))
})

test('duplicate titles use unambiguous IDs; shadowed IDs and dual relation keys fail', (t) => {
  const f = fixture(t)
  f.put('x/one', document('Same')); f.put('y/two', document('Same'))
  const add = () => ['relations', 'add', '--note', 'projects/alpha', '--revision', f.read().revision, '--kind', 'related_to', '--target', 'x/one']
  f.run(add())
  assert.deepEqual(f.disk().properties.related_to, ['[[x/one]]'])
  f.put('shadow', document('x/one'))
  assert.equal(f.run(add(), 1).error.code, 'AMBIGUOUS_LINK')
  const d = f.disk(); d.properties['related to'] = ['[[Same]]']; f.put('projects/alpha', d)
  assert.equal(f.run(add(), 1).error.code, 'RELATION_KEYS')
})

test('path traversal, symlinks, malformed documents and unknown arguments do not mutate files', (t) => {
  const f = fixture(t)
  assert.equal(f.run(['read', '--note', '../escape'], 1).error.code, 'INVALID_ID')
  symlinkSync(join(f.vault, 'projects'), join(f.vault, 'linked'))
  assert.equal(f.run(['read', '--note', 'linked/alpha'], 1).error.code, 'SYMLINK')
  assert.equal(f.run([...f.writeArgs('insert'), '--text', 'oops', '--dry-rnu'], 1).error.code, 'ARGUMENT')
  f.put('bad', { format: 'tiptap', doc: { type: 'doc', content: [{ type: 'text', text: '' }] } })
  assert.equal(f.run(['read', '--note', 'bad'], 1).error.code, 'INVALID_DOCUMENT')
})

test('cooperative lock prevents competing writers', (t) => {
  const f = fixture(t)
  writeFileSync(join(f.vault, 'projects/.alpha.stride.json.agent.lock'), 'another writer')
  assert.equal(f.run([...f.writeArgs('insert'), '--text', 'blocked'], 1).error.code, 'LOCKED')
  assert.deepEqual(f.disk(), document())
})

test('missing flag values cannot swallow dry-run and accidentally write', (t) => {
  const f = fixture(t)
  assert.equal(f.run([...f.writeArgs('replace-text'), '--block', 'b1', '--old', '周五', '--new', '--dry-run'], 1).error.code, 'ARGUMENT')
  assert.deepEqual(f.disk(), document())
})

test('removing a nonexistent relation preserves original whitespace and empty array entries', (t) => {
  const f = fixture(t)
  f.put('b', document('Beta'))
  const doc = f.disk(); doc.properties.related_to = ['', '  ', '保留文字']; f.put('projects/alpha', doc)
  const result = f.run(['relations', 'remove', '--note', 'projects/alpha', '--revision', f.read().revision, '--kind', 'related_to', '--target', 'b'])
  assert.equal(result.changed, false)
  assert.deepEqual(f.disk(), doc)
})

test('relationship title resolution matches Stride for wikilinks with aliases in a leading H1', (t) => {
  const f = fixture(t)
  const target = document('Stored title')
  target.doc.content[0].content = [{ type: 'wikilink', attrs: { target: 'RealTitle', alias: 'Display alias' } }]
  f.put('target', target)
  const listing = f.run(['list'])
  assert.equal(listing.find((entry) => entry.id === 'target').title, 'RealTitle')
  f.run(['relations', 'add', '--note', 'projects/alpha', '--revision', f.read().revision, '--kind', 'related_to', '--target', 'target'])
  assert.deepEqual(f.disk().properties.related_to, ['[[RealTitle]]'])
})

test('skill scripts work after copying away from repository and node_modules', (t) => {
  const f = fixture(t)
  const destination = join(f.vault, 'portable')
  cpSync(dirname(script), destination, { recursive: true })
  const result = spawnSync(process.execPath, [join(destination, 'stride.mjs'), 'read', '--vault', f.vault, '--note', 'projects/alpha'], { cwd: tmpdir(), encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).id, 'projects/alpha')
  const converted = spawnSync(process.execPath, [join(destination, 'stride.mjs'), 'convert', '--from', '-'], {
    cwd: tmpdir(), encoding: 'utf8', input: '# Portable\n\n**bold**\n',
  })
  assert.equal(converted.status, 0, converted.stderr)
  assert.equal(JSON.parse(converted.stdout).document.doc.content[1].content[0].marks[0].type, 'bold')
})

const sampleMarkdown = `---
title: Ignored
type: Project
status: active
count: 3
tags:
  - a
  - b
belongs_to:
  - "[[Team]]"
---

# Alpha

See **bold** and *italic* and ~~gone~~ and \`code\` and ==mark==.
A [link](https://example.com) and [[Team|Alias]] and $E=mc^2$.

- item
  - child

- [ ] todo
- [x] done

1. first

3. third

> quote

> [!WARNING]
> Careful

| A | B |
| --- | --- |
| 1 | 2 |

\`\`\`ts
# not a heading
const [[nope]] = 1
\`\`\`

\`\`\`mermaid
graph TD
\`\`\`

![shot](attachments/shot.png)

![local](./local.png)

<div>kept</div>

\\[
a+b
\\]
`

test('markdown conversion builds editor nodes and reports degraded syntax', () => {
  const built = buildNote(sampleMarkdown)
  const content = built.document.doc.content
  const ofType = (type) => content.filter((node) => node.type === type)
  assert.equal(built.document.title, 'Alpha')
  assert.equal(built.titleSource, 'h1')
  assert.equal(built.document.type, 'Project')
  assert.equal(built.document.properties.title, undefined)
  assert.equal(built.document.properties.status, 'active')
  assert.equal(built.document.properties.count, 3)
  assert.deepEqual(built.document.properties.tags, ['a', 'b'])
  assert.deepEqual(built.document.properties.belongs_to, ['[[Team]]'])
  assert.equal(content[0].content[0].text, 'Alpha')
  const paragraph = content.find((node) => node.content?.some((child) => child.text === 'bold'))
  assert.deepEqual(paragraph.content.find((child) => child.text === 'bold').marks, [{ type: 'bold' }])
  assert.deepEqual(paragraph.content.find((child) => child.text === 'italic').marks, [{ type: 'italic' }])
  assert.deepEqual(paragraph.content.find((child) => child.text === 'gone').marks, [{ type: 'strike' }])
  assert.deepEqual(paragraph.content.find((child) => child.text === 'code').marks, [{ type: 'code' }])
  assert.deepEqual(paragraph.content.find((child) => child.text === 'mark').marks, [{ type: 'highlight' }])
  assert.equal(paragraph.content.find((child) => child.text === 'link').marks[0].attrs.href, 'https://example.com')
  assert.deepEqual(paragraph.content.find((child) => child.type === 'wikilink').attrs, { target: 'Team', alias: 'Alias' })
  assert.equal(paragraph.content.find((child) => child.type === 'inlineMath').attrs.latex, 'E=mc^2')
  const bullet = ofType('bulletList')[0]
  assert.equal(bullet.content[0].content[0].content[0].text, 'item')
  assert.equal(bullet.content[0].content[1].type, 'bulletList')
  assert.equal(bullet.content[0].content[1].content[0].content[0].content[0].text, 'child')
  const tasks = ofType('taskList')[0]
  assert.equal(tasks.content[0].attrs.checked, false)
  assert.equal(tasks.content[1].attrs.checked, true)
  assert.equal(tasks.content[0].content[0].type, 'paragraph')
  const ordered = ofType('orderedList')
  assert.equal(ordered[0].attrs, undefined)
  assert.equal(ordered[1].attrs.start, 3)
  assert.equal(ofType('blockquote')[0].content[0].content[0].text, 'quote')
  assert.equal(ofType('callout')[0].attrs.kind, 'warning')
  assert.equal(ofType('callout')[0].content[0].content[0].text, 'Careful')
  const table = ofType('table')[0]
  assert.equal(table.content[0].content[0].type, 'tableHeader')
  assert.equal(table.content[1].content[1].content[0].content[0].text, '2')
  const code = ofType('codeBlock')[0]
  assert.equal(code.attrs.language, 'ts')
  assert.match(code.content[0].text, /# not a heading/)
  assert.match(code.content[0].text, /\[\[nope\]\]/)
  assert.equal(code.content.some((node) => node.type === 'wikilink'), false)
  assert.equal(ofType('mermaid')[0].attrs.view, 'render')
  assert.match(ofType('mermaid')[0].content[0].text, /graph TD/)
  assert.deepEqual(ofType('image')[0].attrs, { src: 'attachments/shot.png', alt: 'shot' })
  assert.equal(ofType('blockMath')[0].attrs.latex, 'a+b')
  assert.ok(content.some((node) => node.type === 'paragraph' && node.content?.some((child) => child.text?.includes('<div>kept</div>'))))
  assert.ok(content.some((node) => node.type === 'paragraph' && node.content?.some((child) => child.text?.includes('![local](./local.png)'))))
  assert.equal(content.at(-1).type, 'paragraph')
  assert.deepEqual(built.warnings.map((warning) => warning.code).sort(), ['html-kept', 'image-kept', 'title-mismatch'])
})

test('markdown headings, frontmatter and literal inserts stay distinct', () => {
  const titled = buildNote('No heading\n', { fallbackTitle: 'stem' })
  assert.equal(titled.document.title, 'stem')
  assert.equal(titled.titleSource, 'filename')
  assert.equal(titled.document.doc.content[0].content[0].text, 'stem')
  const fromMatter = buildNote('---\ntitle: From matter\n---\n\nBody\n')
  assert.equal(fromMatter.titleSource, 'frontmatter')
  assert.equal(fromMatter.document.doc.content[0].type, 'heading')
  assert.equal(fromMatter.document.doc.content[1].content[0].text, 'Body')
  const wrapped = buildNote('**hello\nworld**\n')
  assert.equal(wrapped.document.doc.content[0].content[0].text, 'hello world')
  assert.deepEqual(wrapped.document.doc.content[0].content[0].marks, [{ type: 'bold' }])
  const broken = buildNote('hello  \nworld\\\nnext\n')
  assert.deepEqual(broken.document.doc.content[0].content.map((node) => node.type === 'text' ? node.text : node.type), ['hello', 'hardBreak', 'world', 'hardBreak', 'next'])
  const literal = buildNote('---\nbio: |\n  hello\n  world\n---\n\n# T\n')
  assert.equal(literal.document.properties.bio, 'hello\nworld')
  const loose = buildNote('- one\n\n  still\n\n- two\n\n1. a\n\n2. b\n')
  const bulletLists = loose.document.doc.content.filter((node) => node.type === 'bulletList')
  const orderedLists = loose.document.doc.content.filter((node) => node.type === 'orderedList')
  assert.equal(bulletLists.length, 1)
  assert.equal(bulletLists[0].content.length, 2)
  assert.equal(bulletLists[0].content[0].content[1].content[0].text, 'still')
  assert.equal(orderedLists.length, 1)
  assert.equal(orderedLists[0].content.length, 2)
  assert.equal(orderedLists[0].attrs, undefined)
  const headingImage = buildNote('# see **![x](attachments/a.png)**\n')
  const heading = headingImage.document.doc.content[0]
  assert.equal(heading.content.some((node) => node.type === 'image'), false)
  assert.ok(heading.content.some((node) => node.text?.includes('![x](attachments/a.png)') && node.marks?.some((mark) => mark.type === 'bold')))
  assert.ok(headingImage.warnings.some((warning) => warning.code === 'image-inline'))
  const mail = buildNote('<mailto:a@b.c>\n')
  assert.equal(mail.document.doc.content[0].content[0].marks[0].attrs.href, 'mailto:a@b.c')
  assert.equal(mail.warnings.some((warning) => warning.code === 'html-kept'), false)
  const linkedImage = buildNote('[![alt](attachments/a.png)](https://example.com/go)\n')
  assert.equal(linkedImage.document.doc.content.some((node) => node.type === 'image'), false)
  assert.equal(linkedImage.document.doc.content[0].content[0].marks[0].attrs.href, 'https://example.com/go')
  assert.ok(linkedImage.warnings.some((warning) => warning.code === 'image-inline'))
  const linkedMath = buildNote('[$E=mc^2$](https://example.com/go)\n')
  assert.equal(linkedMath.document.doc.content[0].content.some((node) => node.text === 'https://example.com/go'), true)
  assert.ok(linkedMath.warnings.some((warning) => warning.code === 'link-kept'))
  const codeBreak = buildNote('`code\\\nmore`\n')
  assert.equal(codeBreak.document.doc.content[0].content.some((node) => node.type === 'hardBreak'), false)
  assert.equal(codeBreak.document.doc.content[0].content[0].text, 'code\\ more')
  const codeSpaces = buildNote('`code  \nmore`\n')
  assert.equal(codeSpaces.document.doc.content[0].content.some((node) => node.type === 'hardBreak'), false)
  assert.match(codeSpaces.document.doc.content[0].content[0].text, /code {2}/)
  const brokenLink = buildNote('[label](https://example.com/a\nb)\n')
  assert.equal(JSON.stringify(brokenLink.document).includes('\uE000'), false)
  assert.match(JSON.stringify(brokenLink.document), /example\.com\/a/)
  const brokenImage = buildNote('![alt](attachments/foo\nbar.png)\n')
  assert.equal(brokenImage.document.doc.content.some((node) => node.type === 'image'), false)
  assert.equal(JSON.stringify(brokenImage.document).includes('\uE000'), false)
  const proto = buildNote('---\n__proto__: hi\nconstructor: keep\n---\n\n# T\n')
  assert.deepEqual(Object.entries(proto.document.properties), [['__proto__', 'hi'], ['constructor', 'keep']])
  const meta = buildNote('---\nmeta:\n  a: 1\n  b:\n    c: 2\n---\n\n# T\n')
  assert.equal(meta.document.properties.meta, '{"a":1,"b":{"c":2}}')
  assert.ok(meta.warnings.some((warning) => warning.code === 'frontmatter-degraded'))
  const nestedTags = buildNote('---\ntags:\n  - a\n    - b\n---\n\n# T\n')
  assert.equal(nestedTags.document.properties.tags, '[["a",["b"]]]')
  assert.ok(nestedTags.warnings.some((warning) => warning.code === 'frontmatter-degraded'))
  const flow = buildNote('---\nitems: [[a], b]\n---\n\n# T\n')
  assert.equal(flow.document.properties.items, '[["a"],"b"]')
  const spaces = buildNote('---\nbio: |\n  hello  \n  world\n---\n\n# T\n')
  assert.equal(spaces.document.properties.bio, 'hello  \nworld')
  const headingImageUnsafe = buildNote('# ![x](./local.png)\n')
  assert.ok(headingImageUnsafe.warnings.some((warning) => warning.code === 'image-inline'))
  assert.equal(headingImageUnsafe.warnings.some((warning) => warning.code === 'image-kept'), false)
})

test('import creates a note, refuses overwrite, and insert-markdown preserves the rest', (t) => {
  const f = fixture(t)
  const file = join(f.vault, 'note.md')
  writeFileSync(file, sampleMarkdown)
  const preview = f.run(['import', '--note', 'guides/alpha', '--from', file, '--dry-run'])
  assert.equal(preview.dryRun, true)
  assert.equal(existsSync(join(f.vault, 'guides')), false)
  const created = f.run(['import', '--note', 'guides/alpha', '--from', file])
  assert.equal(created.id, 'guides/alpha')
  assert.equal(created.document.type, 'Project')
  const read = f.run(['read', '--note', 'guides/alpha'])
  assert.equal(read.revision, created.revision)
  assert.equal(read.blocks.find((block) => block.type === 'codeBlock').language, 'ts')
  assert.equal(read.blocks.find((block) => block.type === 'taskItem' && block.checked === true).text, 'done')
  const before = readFileSync(join(f.vault, 'guides/alpha.stride.json'), 'utf8')
  assert.equal(f.run(['import', '--note', 'guides/alpha', '--from', file], 1).error.code, 'EXISTS')
  assert.equal(readFileSync(join(f.vault, 'guides/alpha.stride.json'), 'utf8'), before)
  const original = f.read()
  f.run([...f.writeArgs('insert-markdown'), '--after', 'b1', '--markdown', '## Section\n\n- kept **fmt**'])
  assert.equal(f.disk().doc.content[2].type, 'heading')
  assert.equal(f.disk().doc.content[3].type, 'bulletList')
  assert.equal(f.disk().doc.content[3].content[0].content[0].content[1].marks[0].type, 'bold')
  assert.equal(f.disk().properties.status, original.document.properties.status)
  assert.equal(f.disk().doc.content[5].type, 'table')
  assert.equal(f.run([...f.writeArgs('insert-markdown'), '--before', 'b0', '--markdown', 'nope'], 1).error.code, 'TITLE_PROTECTED')
  assert.equal(f.run([...f.writeArgs('insert-markdown'), '--markdown-file', '-'], 1, '---\ntitle: X\n---\n\nHi').error.code, 'FRONTMATTER')
  assert.equal(f.run([...f.writeArgs('replace-block'), '--block', 'b0', '--markdown', 'replacement'], 1).error.code, 'TITLE_PROTECTED')
  const table = f.read().blocks.find((block) => block.type === 'table')
  assert.equal(f.run([...f.writeArgs('replace-block'), '--block', table.ref, '--markdown', 'replacement'], 1).error.code, 'RICH_CONTENT')
  const bytes = readFileSync(join(f.vault, 'projects/alpha.stride.json'), 'utf8')
  f.run([...f.writeArgs('apply'), '--operations', '-'], 1, JSON.stringify([
    { op: 'insert-markdown', after: 'b1', markdown: 'added' },
    { op: 'replace-text', block: 'b1', old: 'missing', new: 'x' },
  ]))
  assert.equal(readFileSync(join(f.vault, 'projects/alpha.stride.json'), 'utf8'), bytes)
  symlinkSync(join(f.vault, 'projects'), join(f.vault, 'linked'))
  assert.equal(f.run(['import', '--note', 'linked/nope', '--from', file], 1).error.code, 'SYMLINK')
  assert.equal(f.run(['import', '--note', '../escape', '--from', file], 1).error.code, 'INVALID_ID')
})
