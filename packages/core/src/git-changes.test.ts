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

  it('decodes octal-quoted paths and still parses the rest of the table', () => {
    const porcelain = [
      '?? "\\347\\254\\224\\350\\256\\260.stride.json"',
      'UU "\\347\\254\\224\\350\\256\\260.stride.json"',
      ' M notes/a.stride.json',
      '?? "\\344\\270\\255\\346\\226\\207 -> \\350\\267\\257\\345\\276\\204.stride.json"',
      '?? "中文 -> 路径.stride.json"',
    ].join('\n')
    expect(parsePorcelain(porcelain)).toEqual([
      change({ path: '笔记.stride.json', code: '??', untracked: true }),
      change({ path: '笔记.stride.json', code: 'UU', unmerged: true }),
      change({ path: 'notes/a.stride.json', code: ' M', unstaged: true }),
      change({ path: '中文 -> 路径.stride.json', code: '??', untracked: true }),
      change({ path: '中文 -> 路径.stride.json', code: '??', untracked: true }),
    ])
  })

  it('splits renames on the status arrow, including quoted and octal paths', () => {
    expect(parsePorcelain('R  "notes/old note.stride.json" -> "notes/new note.stride.json"')).toEqual([
      change({ path: 'notes/new note.stride.json', code: 'R ', staged: true }),
    ])
    expect(parsePorcelain('R  old.stride.json -> "new note.stride.json"')).toEqual([
      change({ path: 'new note.stride.json', code: 'R ', staged: true }),
    ])
    expect(parsePorcelain('R  "notes/a -> b.stride.json" -> notes/c.stride.json')).toEqual([
      change({ path: 'notes/c.stride.json', code: 'R ', staged: true }),
    ])
    expect(parsePorcelain(
      'R  "\\346\\234\\252\\346\\232\\202\\345\\255\\230\\347\\254\\224\\350\\256\\260.stride.json" -> "\\346\\226\\260\\347\\254\\224\\350\\256\\260.stride.json"',
    )).toEqual([
      change({ path: '新笔记.stride.json', code: 'R ', staged: true }),
    ])
    expect(parsePorcelain(
      'RM "\\346\\234\\252\\346\\232\\202\\345\\255\\230\\347\\254\\224\\350\\256\\260.stride.json" -> "\\346\\226\\260\\347\\254\\224\\350\\256\\260.stride.json"',
    )).toEqual([
      change({ path: '新笔记.stride.json', code: 'RM', staged: true, unstaged: true }),
    ])
    expect(parsePorcelain(' R notes/old.stride.json -> notes/new.stride.json')).toEqual([
      change({ path: 'notes/new.stride.json', code: ' R', unstaged: true }),
    ])
    expect(parsePorcelain('C  notes/old.stride.json -> notes/new.stride.json')).toEqual([
      change({ path: 'notes/new.stride.json', code: 'C ', staged: true }),
    ])
  })

  it('keeps an arrow that is part of the path when the status is not a rename', () => {
    expect(parsePorcelain('?? notes/a -> b.stride.json')).toEqual([
      change({ path: 'notes/a -> b.stride.json', code: '??', untracked: true }),
    ])
    expect(parsePorcelain('?? "notes/a -> b.stride.json"')).toEqual([
      change({ path: 'notes/a -> b.stride.json', code: '??', untracked: true }),
    ])
    expect(parsePorcelain(' M "notes/a -> b.stride.json"')[0]?.path).toBe('notes/a -> b.stride.json')
  })

  it('throws on a non-empty malformed line', () => {
    expect(() => parsePorcelain('M notes/a.stride.json')).toThrow('Malformed git status')
    expect(() => parsePorcelain('nope')).toThrow('Malformed git status')
    expect(() => parsePorcelain('?? "unterminated')).toThrow('Malformed git path')
    expect(() => parsePorcelain('?? "bad\\q"')).toThrow('Malformed git path')
    expect(() => parsePorcelain('?? "\\400"')).toThrow('Malformed git path')
    expect(() => parsePorcelain('?? "\\12"')).toThrow('Malformed git path')
    expect(() => parsePorcelain('R  notes/only.stride.json')).toThrow('Malformed git status')
  })

  it('throws when a path escapes the vault', () => {
    expect(() => parsePorcelain('?? ../outside')).toThrow('Path escapes the vault')
    expect(() => parsePorcelain('?? notes/../../outside')).toThrow('Path escapes the vault')
    expect(() => parsePorcelain('?? /etc/passwd')).toThrow('Path escapes the vault')
    expect(() => parsePorcelain('?? notes/a\0b')).toThrow('Path escapes the vault')
    expect(() => parsePorcelain('R  notes/old.stride.json -> ../new.stride.json')).toThrow('Path escapes the vault')
  })
})
