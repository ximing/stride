import { describe, expect, it } from 'vitest'
import { MemoryAppDataStore } from '@stride/platform'
import {
  FILE_CHANGE_DIFF_CHARS,
  TURN_BODY_FILE_BYTES,
  TURN_BODY_FILE_CAP,
  TURN_BODY_TOTAL_BYTES,
  TURN_FILE_ROW_CAP,
  TURN_MANIFEST_CAP,
  TURN_PACK_MAX_BYTES,
  TURN_RESULT_TOO_LARGE,
  TURN_RESULT_UNDOABLE,
  buildTurnUndoPack,
  captureTurnBaseline,
  diffTurnNotes,
  formatFileChangeResult,
  parseTurnUndoPack,
  planTurnUndo,
  serializeTurnUndoPack,
  turnPackHasUndo,
  turnPackListPrefix,
  turnPackPath,
  turnPackRemovePaths,
  turnPacksToDelete,
  type TurnBaselineNote,
  type TurnUndoPackOptions,
} from './chat-turn-diff'

const ABC_SHA = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
const SECRET = 'sk-live-PREIMAGE-secret'
const PACK: Omit<TurnUndoPackOptions, 'excludeIds'> = {
  vaultKey: 'vaultkey',
  sessionId: 'session',
  turnId: 'turn',
  writtenAt: '2026-11-13T00:00:00.000Z',
}

function note(id: string, serialized: Uint8Array | string, mtime = 1): TurnBaselineNote {
  return { id, serialized, mtime }
}

function packOptions(excludeIds?: ReadonlySet<string>): TurnUndoPackOptions {
  return excludeIds ? { ...PACK, excludeIds } : { ...PACK }
}

describe('captureTurnBaseline', () => {
  it('hashes with the sync SHA-256 and keeps the original string', () => {
    const baseline = captureTurnBaseline({
      notes: [note('abc', 'abc', 4), note('bytes', new TextEncoder().encode('abc'), 5)],
      openTabIds: [],
      activeId: null,
    })
    expect(baseline.partial).toBe(false)
    expect(baseline.entries.map((entry) => entry.sha256)).toEqual([ABC_SHA, ABC_SHA])
    expect(baseline.entries.every((entry) => entry.bytes === 'abc' && entry.undoable)).toBe(true)
    expect(baseline.entries[0]).toMatchObject({ mtime: 4, size: 3 })
  })

  it('counts UTF-8 bytes and keeps a body at the per-file cap', () => {
    const exact = 'a'.repeat(TURN_BODY_FILE_BYTES)
    const baseline = captureTurnBaseline({
      notes: [note('cjk', '你'), note('exact', exact), note('over', `${exact}b`)],
      openTabIds: ['over'],
      activeId: null,
    })
    expect(baseline.entries.find((entry) => entry.id === 'cjk')).toMatchObject({ size: 3, undoable: true, bytes: '你' })
    const capped = baseline.entries.find((entry) => entry.id === 'exact')
    const over = baseline.entries.find((entry) => entry.id === 'over')
    expect(capped).toMatchObject({ size: TURN_BODY_FILE_BYTES, undoable: true })
    expect(over).toMatchObject({ size: TURN_BODY_FILE_BYTES + 1, undoable: false })
    expect(over?.bytes).toBeUndefined()
    expect(over?.sha256).toHaveLength(64)
  })

  it('keeps open tabs, then the active note, ahead of smaller notes', () => {
    const notes: TurnBaselineNote[] = []
    for (let index = 0; index < TURN_BODY_FILE_CAP + 6; index += 1) {
      notes.push(note(`n${String(index).padStart(2, '0')}`, 'x'))
    }
    notes[69] = note('n69', 'yy')
    notes[68] = note('n68', 'zzz')
    const baseline = captureTurnBaseline({ notes, openTabIds: ['n69', 'missing', 'n69'], activeId: 'n68' })
    const undoable = baseline.entries.filter((entry) => entry.undoable).map((entry) => entry.id)
    expect(undoable).toHaveLength(TURN_BODY_FILE_CAP)
    expect(undoable.slice(0, 2)).toEqual(['n69', 'n68'])
    expect(undoable).toContain('n00')
    expect(undoable).not.toContain('n62')
    expect(baseline.entries.find((entry) => entry.id === 'n69')?.bytes).toBe('yy')
  })

  it('keeps a later body that fits after a larger one misses the remaining budget', () => {
    const almost = 'a'.repeat(TURN_BODY_FILE_BYTES - 1)
    const open = [
      ...Array.from({ length: 32 }, (_, index) => `o${String(index).padStart(2, '0')}`),
      'too-wide',
      'fits',
    ]
    const baseline = captureTurnBaseline({
      notes: [
        ...open.slice(0, 32).map((id) => note(id, almost)),
        note('too-wide', 'b'.repeat(100)),
        note('fits', 'c'.repeat(10)),
      ],
      openTabIds: open,
      activeId: null,
    })
    expect(baseline.entries.find((entry) => entry.id === 'too-wide')?.undoable).toBe(false)
    expect(baseline.entries.find((entry) => entry.id === 'fits')).toMatchObject({ undoable: true, bytes: 'c'.repeat(10) })
    expect(baseline.entries.filter((entry) => entry.undoable)).toHaveLength(33)
  })

  it('stops retaining bodies once the 4MiB total is full', () => {
    const chunk = 'a'.repeat(TURN_BODY_FILE_BYTES)
    const notes = Array.from({ length: 33 }, (_, index) => note(`b${String(index).padStart(2, '0')}`, chunk))
    const baseline = captureTurnBaseline({ notes, openTabIds: [], activeId: null })
    const kept = baseline.entries.filter((entry) => entry.undoable)
    expect(kept.map((entry) => entry.id)).toEqual(notes.slice(0, 32).map((entry) => entry.id))
    expect(kept.reduce((sum, entry) => sum + entry.size, 0)).toBe(TURN_BODY_TOTAL_BYTES)
    expect(baseline.entries.find((entry) => entry.id === 'b32')).toMatchObject({ undoable: false, size: TURN_BODY_FILE_BYTES })
    expect(baseline.entries.find((entry) => entry.id === 'b32')?.bytes).toBeUndefined()
  })

  it('marks a vault past 5000 notes partial and keeps only open tabs and the active note', () => {
    const notes = Array.from({ length: TURN_MANIFEST_CAP + 1 }, (_, index) => note(`n${index}`, index === 2 ? 'SECRET-UNLISTED' : 'x'))
    const baseline = captureTurnBaseline({ notes, openTabIds: ['n0'], activeId: 'n1' })
    expect(baseline.partial).toBe(true)
    expect(baseline.entries.map((entry) => entry.id)).toEqual(['n0', 'n1'])
    expect(JSON.stringify(baseline)).not.toContain('SECRET-UNLISTED')

    const exact = Array.from({ length: TURN_MANIFEST_CAP }, (_, index) => note(`e${index}`, 'x'))
    const full = captureTurnBaseline({ notes: exact, openTabIds: [], activeId: null })
    expect(full.partial).toBe(false)
    expect(full.entries).toHaveLength(TURN_MANIFEST_CAP)
  })

  it('drops duplicate ids, .git, .stride, and the first copy wins', () => {
    const baseline = captureTurnBaseline({
      notes: [
        note('a', 'first', 1),
        note('a', 'second', 9),
        note('.git/config', 'secret'),
        note('.stride/vault', 'secret'),
        note('../outside', 'secret'),
      ],
      openTabIds: ['a'],
      activeId: 'missing',
    })
    expect(baseline.entries).toEqual([
      expect.objectContaining({ id: 'a', bytes: 'first', mtime: 1, undoable: true }),
    ])
  })
})

describe('diffTurnNotes', () => {
  it('uses hash, so a mtime-only touch is quiet and a same-mtime edit is modified', () => {
    const baseline = captureTurnBaseline({
      notes: [note('same', 'abc', 1), note('edited', 'abc', 1), note('gone', 'bye', 1)],
      openTabIds: ['gone'],
      activeId: 'edited',
    })
    const diff = diffTurnNotes(baseline, [
      note('same', 'abc', 50),
      note('edited', 'abcd', 1),
      note('fresh', 'new', 3),
    ])
    expect(diff.changes.map((change) => [change.change, change.id])).toEqual([
      ['deleted', 'gone'],
      ['modified', 'edited'],
      ['created', 'fresh'],
    ])
    expect(diff.rows.map((row) => row.result)).toEqual([TURN_RESULT_UNDOABLE, TURN_RESULT_UNDOABLE, TURN_RESULT_UNDOABLE])
    expect(JSON.stringify(diff.rows)).not.toContain('bye')
    expect(diff.changes.find((change) => change.id === 'edited')?.bytes).toBe('abc')
    expect(diff.changes.find((change) => change.id === 'fresh')?.sha256).toHaveLength(64)
  })

  it('does not invent creates from notes a partial baseline never recorded', () => {
    const notes = Array.from({ length: TURN_MANIFEST_CAP + 1 }, (_, index) => note(`n${index}`, 'x'))
    const baseline = captureTurnBaseline({ notes, openTabIds: ['n0'], activeId: null })
    const current = notes.map((entry) => (entry.id === 'n0' ? note('n0', 'y', 2) : entry)).concat(note('brand-new', 'z', 2))
    const diff = diffTurnNotes(baseline, current)
    expect(diff.partial).toBe(true)
    expect(diff.changes.map((change) => change.id)).toEqual(['n0'])
    expect(diff.changes[0]).toMatchObject({ change: 'modified', undoable: true, bytes: 'x' })
  })

  it('reports an oversized edit as too large and folds the rest into one truncated row', () => {
    const chunk = 'a'.repeat(TURN_BODY_FILE_BYTES)
    const notes = [note('big', `${chunk}!`), ...Array.from({ length: TURN_FILE_ROW_CAP }, (_, index) => note(`s${index}`, 'v'))]
    const baseline = captureTurnBaseline({ notes, openTabIds: ['big'], activeId: null })
    const diff = diffTurnNotes(
      baseline,
      notes.map((entry) => note(entry.id, `${entry.serialized}z`, 2)),
    )
    expect(diff.rows).toHaveLength(TURN_FILE_ROW_CAP + 1)
    expect(diff.rows[0]).toEqual({
      id: 'file:big:modified',
      name: 'file',
      args: { id: 'big', change: 'modified' },
      result: TURN_RESULT_TOO_LARGE,
    })
    expect(diff.rows.at(-1)).toEqual({ id: 'truncated', name: 'truncated', args: null, result: '1 more events omitted' })
    expect(diff.rows.slice(1, -1).every((row) => row.name === 'file' && row.result === TURN_RESULT_UNDOABLE)).toBe(true)
    expect(JSON.stringify(diff.rows)).not.toContain(chunk.slice(0, 32))
  })
})

describe('undo pack and plan', () => {
  it('writes pre-image bytes back without redacting them', () => {
    const baseline = captureTurnBaseline({
      notes: [note('kept', SECRET), note('dirty', 'draft')],
      openTabIds: [],
      activeId: 'dirty',
    })
    const diff = diffTurnNotes(baseline, [note('kept', 'after', 2), note('dirty', 'after', 2)])
    const pack = buildTurnUndoPack(diff, packOptions())
    expect(serializeTurnUndoPack(pack)).toContain(SECRET)
    expect(serializeTurnUndoPack(pack)).not.toContain('••••')
    expect(parseTurnUndoPack(serializeTurnUndoPack(pack))).toEqual(pack)
    expect(turnPackHasUndo(pack)).toBe(true)

    const clean = planTurnUndo(pack, [note('kept', 'after'), note('dirty', 'after')], new Set())
    expect(clean.steps).toContainEqual({ op: 'write', id: 'kept', bytes: SECRET })
    expect(clean.skippedIds).toEqual([])

    const blocked = planTurnUndo(pack, [note('kept', 'after'), note('dirty', 'after')], new Set(['dirty']))
    expect(blocked.steps).toContainEqual({ op: 'openBanner', id: 'dirty' })
    expect(blocked.steps.some((step) => step.op === 'write' && step.id === 'dirty')).toBe(false)
    expect(blocked.steps).toContainEqual({ op: 'write', id: 'kept', bytes: SECRET })
  })

  it('restores a deleted note and deletes a created note only while its end hash matches', () => {
    const body = '{"title":"Created"}\n'
    const baseline = captureTurnBaseline({ notes: [note('old', 'was-here')], openTabIds: [], activeId: null })
    const created = diffTurnNotes(baseline, [note('fresh', body, 2)])
    const pack = buildTurnUndoPack(created, packOptions())
    expect(pack.files.map((file) => file.change).sort()).toEqual(['created', 'deleted'])

    const matched = planTurnUndo(pack, [note('fresh', body)], new Set())
    expect(matched.steps).toEqual([
      { op: 'write', id: 'old', bytes: 'was-here' },
      { op: 'delete', id: 'fresh' },
    ])
    expect(matched.skippedIds).toEqual([])

    const edited = planTurnUndo(pack, [note('fresh', `${body}later`)], new Set())
    expect(edited.steps).toContainEqual({ op: 'skip', id: 'fresh', reason: 'changed' })
    expect(edited.steps.some((step) => step.op === 'delete')).toBe(false)
    expect(edited.skippedIds).toEqual(['fresh'])

    const replaced = planTurnUndo(pack, [{ id: 'fresh', serialized: body, note: false }], new Set())
    expect(replaced.steps).toContainEqual({ op: 'skip', id: 'fresh', reason: 'not-note' })
    expect(replaced.skippedIds).toEqual([])

    const removed = planTurnUndo(pack, [], new Set())
    expect(removed.steps).toContainEqual({ op: 'skip', id: 'fresh', reason: 'missing' })
    expect(removed.steps).toContainEqual({ op: 'write', id: 'old', bytes: 'was-here' })
  })

  it('omits power shell ids and does not delete a move when both ids are excluded', () => {
    const body = '{"title":"Moved"}\n'
    const baseline = captureTurnBaseline({
      notes: [note('old', body), note('edited', 'before'), note('doomed', 'gone')],
      openTabIds: [],
      activeId: null,
    })
    const current = [note('moved', body, 2), note('edited', 'after', 2)]
    const diff = diffTurnNotes(baseline, current)
    expect(diff.changes.map((change) => `${change.change}:${change.id}`).sort()).toEqual([
      'created:moved',
      'deleted:doomed',
      'deleted:old',
      'modified:edited',
    ])

    const excluded = new Set(['old', 'moved', 'edited', 'doomed'])
    const shell = buildTurnUndoPack(diff, packOptions(excluded))
    expect(shell.files).toEqual([])
    const shellPlan = planTurnUndo(shell, current, new Set())
    expect(shellPlan.steps.some((step) => step.op === 'delete' && step.id === 'moved')).toBe(false)
    expect(shellPlan.steps).toEqual([])

    const oldOnly = buildTurnUndoPack(diff, packOptions(new Set(['old'])))
    expect(planTurnUndo(oldOnly, current, new Set()).steps).toContainEqual({ op: 'delete', id: 'moved' })

    const external = planTurnUndo(buildTurnUndoPack(diff, packOptions()), current, new Set())
    expect(external.steps).toEqual([
      { op: 'write', id: 'doomed', bytes: 'gone' },
      { op: 'write', id: 'edited', bytes: 'before' },
      { op: 'write', id: 'old', bytes: body },
      { op: 'delete', id: 'moved' },
    ])
  })

  it('keeps a serialized pack within 4MiB and never stores a fileChange diff', () => {
    const chunk = 'a'.repeat(TURN_BODY_FILE_BYTES)
    const notes = Array.from({ length: 32 }, (_, index) => note(`b${String(index).padStart(2, '0')}`, chunk))
    const baseline = captureTurnBaseline({ notes, openTabIds: ['b00'], activeId: null })
    const diff = diffTurnNotes(
      baseline,
      notes.map((entry) => note(entry.id, 'changed', 2)),
    )
    const marker = `DIFF-MARKER-${'x'.repeat(FILE_CHANGE_DIFF_CHARS)}`
    const row = formatFileChangeResult('completed', [{ path: 'readme.md', diff: marker }])
    const pack = buildTurnUndoPack(diff, packOptions())
    const raw = serializeTurnUndoPack(pack)
    expect(encoderBytes(raw)).toBeLessThanOrEqual(TURN_PACK_MAX_BYTES)
    expect(pack.files.length).toBeLessThan(32)
    expect(pack.files[0]?.id).toBe('b00')
    expect(pack.files.some((file) => file.id === 'b31')).toBe(false)
    expect(pack.files.every((file) => file.bytes === chunk)).toBe(true)
    expect(raw).not.toContain('DIFF-MARKER')
    expect(raw).not.toContain('"diff"')
    expect(row).toContain('DIFF-MARKER')
    expect(row).toContain('undo unavailable')
  })

  it('does not write .git or .stride ids even if a pack names them', () => {
    const poisoned = {
      format: 1 as const,
      vaultKey: 'vaultkey',
      sessionId: 'session',
      turnId: 'turn',
      writtenAt: PACK.writtenAt,
      partial: false,
      files: [
        { id: '.git/config', change: 'deleted' as const, undoable: true as const, sha256: 'aa', size: 4, bytes: 'nope' },
        { id: '.stride/vault', change: 'modified' as const, undoable: true as const, sha256: 'bb', size: 4, bytes: 'nope' },
      ],
    }
    expect(turnPackHasUndo(poisoned)).toBe(false)
    expect(planTurnUndo(poisoned, [], new Set()).steps).toEqual([
      { op: 'skip', id: '.git/config', reason: 'not-note' },
      { op: 'skip', id: '.stride/vault', reason: 'not-note' },
    ])
  })

  it('rejects a pack that is not this format', () => {
    expect(parseTurnUndoPack('not-json')).toBeNull()
    expect(parseTurnUndoPack('[]')).toBeNull()
    expect(parseTurnUndoPack('{}')).toBeNull()
  })
})

describe('pack paths', () => {
  it('keeps the newest three file packs and never deletes a directory path', () => {
    expect(turnPackPath('vaultkey', 'session', 'turn')).toBe('agent-turns/vaultkey/session/turn.json')
    expect(() => turnPackPath('vaultkey', 'a/b', 'turn')).toThrow(/session id/)
    expect(() => turnPackListPrefix('..', 'session')).toThrow(/vault key/)
    const prefix = turnPackListPrefix('vaultkey', 'session')
    expect(prefix).toBe('agent-turns/vaultkey/session/')
    const oldest = ['a.json', 'b.json', 'c.json', 'd.json', 'e.json']
    expect(turnPacksToDelete(oldest)).toEqual(['a.json', 'b.json'])
    expect(turnPacksToDelete([prefix, prefix.slice(0, -1), 'a.json', 'b.json', 'c.json', 'd.json'])).toEqual(['a.json'])
    expect(turnPacksToDelete(['a.json', 'b.json', 'c.json'])).toEqual([])
    expect(turnPackRemovePaths([prefix, prefix.slice(0, -1), ...oldest])).toEqual(oldest)
    expect(turnPackRemovePaths([prefix, prefix.slice(0, -1)]).some((path) => path.endsWith('/') || !path.includes('.'))).toBe(false)
  })

  it('lists one session and removes each file instead of the directory prefix', async () => {
    const store = new MemoryAppDataStore()
    const prefix = turnPackListPrefix('vaultkey', 'session')
    await store.writeText(turnPackPath('vaultkey', 'session', 't1'), '{"bytes":"secret"}')
    await store.writeText(turnPackPath('vaultkey', 'session', 't2'), '{"bytes":"secret"}')
    await store.writeText('agent-turns/vaultkey/session-extra/t.json', '{}')
    await store.remove(prefix)
    expect(await store.readText(turnPackPath('vaultkey', 'session', 't1'))).not.toBeNull()
    const listed = await store.list(prefix)
    expect(listed).toEqual([
      'agent-turns/vaultkey/session/t1.json',
      'agent-turns/vaultkey/session/t2.json',
    ])
    const targets = turnPackRemovePaths([prefix, prefix.slice(0, -1), ...listed])
    expect(targets.some((path) => path === prefix || path === prefix.slice(0, -1) || path.endsWith('/'))).toBe(false)
    for (const path of targets) await store.remove(path)
    expect(await store.list(prefix)).toEqual([])
    expect(await store.readText('agent-turns/vaultkey/session-extra/t.json')).not.toBeNull()
  })
})

describe('formatFileChangeResult', () => {
  it('adds undo unavailable for non-notes and caps the diff at 200 characters', () => {
    const diff = 'x'.repeat(FILE_CHANGE_DIFF_CHARS + 50)
    expect(formatFileChangeResult('completed', [{ path: 'notes/a.stride.json', diff }])).toBe(
      `completed; ${'x'.repeat(FILE_CHANGE_DIFF_CHARS)}`,
    )
    expect(formatFileChangeResult('completed', [{ path: 'readme.md', diff }])).toBe(
      `completed; undo unavailable; ${'x'.repeat(FILE_CHANGE_DIFF_CHARS)}`,
    )
    expect(formatFileChangeResult('failed', [{ path: '.git/config', diff: 'PATCH' }])).toBe('failed; undo unavailable; PATCH')
    expect(formatFileChangeResult('completed', [{ path: '.stride/vault.json', diff: 'v' }])).toBe(
      'completed; undo unavailable; v',
    )
    expect(formatFileChangeResult('completed', [{ path: 'sub/.git/a.stride.json', diff: 'v' }])).toContain('undo unavailable')
    expect(
      formatFileChangeResult('completed', [
        { path: 'a.stride.json', diff: 'one' },
        { path: 'b.txt', diff: 'two' },
      ]),
    ).toBe('completed; undo unavailable; one\ntwo')
    expect(formatFileChangeResult('completed', [])).toBe('completed')
  })
})

function encoderBytes(text: string): number {
  return new TextEncoder().encode(text).byteLength
}
