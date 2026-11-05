import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

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
})
