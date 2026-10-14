import { describe, expect, it } from 'vitest'
import { parsePorcelain, type GitChange } from './git-changes.ts'

function change(partial: Pick<GitChange, 'path' | 'code'> & Partial<GitChange>): GitChange {
  return {
    staged: false,
    unstaged: false,
    untracked: false,
    unmerged: false,
    ...partial,
  }
}

describe('parsePorcelain', () => {
  it('returns an empty list for blank porcelain', () => {
    expect(parsePorcelain('')).toEqual([])
    expect(parsePorcelain('   \n\n\t')).toEqual([])
  })

  it('parses staged, unstaged, untracked, added, and deleted records', () => {
    expect(parsePorcelain(' M notes/a.stride.json')).toEqual([
      change({ path: 'notes/a.stride.json', code: ' M', unstaged: true }),
    ])
    expect(parsePorcelain('M  notes/a.stride.json')).toEqual([
      change({ path: 'notes/a.stride.json', code: 'M ', staged: true }),
    ])
    expect(parsePorcelain('MM notes/a.stride.json')).toEqual([
      change({ path: 'notes/a.stride.json', code: 'MM', staged: true, unstaged: true }),
    ])
    expect(parsePorcelain('?? notes/new.stride.json')).toEqual([
      change({ path: 'notes/new.stride.json', code: '??', untracked: true }),
    ])
    expect(parsePorcelain('A  notes/new.stride.json')).toEqual([
      change({ path: 'notes/new.stride.json', code: 'A ', staged: true }),
    ])
    expect(parsePorcelain('D  notes/old.stride.json')).toEqual([
      change({ path: 'notes/old.stride.json', code: 'D ', staged: true }),
    ])
  })

  it('treats unmerged codes as conflicts rather than clean edits', () => {
    for (const code of ['UU', 'AA', 'DD', 'AU', 'UA', 'DU', 'UD']) {
      expect(parsePorcelain(`${code} notes/conflict.stride.json`)).toEqual([
        change({ path: 'notes/conflict.stride.json', code, unmerged: true }),
      ])
    }
  })

  it('keeps the destination path of a rename', () => {
    expect(parsePorcelain('R  notes/old.stride.json -> notes/new.stride.json')).toEqual([
      change({ path: 'notes/new.stride.json', code: 'R ', staged: true }),
    ])
  })

  it('skips empty lines and parses several records', () => {
    const porcelain = ' M notes/a.stride.json\n\n?? notes/new.stride.json\n'
    expect(parsePorcelain(porcelain).map((entry) => entry.path)).toEqual([
      'notes/a.stride.json',
      'notes/new.stride.json',
    ])
  })

  it('unquotes paths and supports escaped quotes and backslashes', () => {
    expect(parsePorcelain('?? "notes/my note.stride.json"')).toEqual([
      change({ path: 'notes/my note.stride.json', code: '??', untracked: true }),
    ])
    expect(parsePorcelain('?? "notes/say \\"hi\\".stride.json"')[0]?.path).toBe('notes/say "hi".stride.json')
    expect(parsePorcelain('?? "notes\\\\a.stride.json"')[0]?.path).toBe('notes\\a.stride.json')
  })

  it('throws on a non-empty malformed line', () => {
    expect(() => parsePorcelain('M notes/a.stride.json')).toThrow('Malformed git status')
    expect(() => parsePorcelain('nope')).toThrow('Malformed git status')
    expect(() => parsePorcelain('?? "unterminated')).toThrow('Malformed git path')
    expect(() => parsePorcelain('?? "bad\\q"')).toThrow('Malformed git path')
  })

  it('throws when a path escapes the vault', () => {
    expect(() => parsePorcelain('?? ../outside')).toThrow('Path escapes the vault')
    expect(() => parsePorcelain('?? notes/../../outside')).toThrow('Path escapes the vault')
    expect(() => parsePorcelain('?? /etc/passwd')).toThrow('Path escapes the vault')
    expect(() => parsePorcelain('?? notes/a\0b')).toThrow('Path escapes the vault')
    expect(() => parsePorcelain('R  notes/old.stride.json -> ../new.stride.json')).toThrow('Path escapes the vault')
  })
})
