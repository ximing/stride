import { describe, expect, it } from 'vitest'
import {
  MemoryFileSystem,
  PlatformError,
  normalizeRelativePath,
  type WatchEvent,
} from './index.ts'

describe('normalizeRelativePath', () => {
  it('treats empty and dot as the root and drops dot segments', () => {
    expect(normalizeRelativePath('')).toBe('')
    expect(normalizeRelativePath('.')).toBe('')
    expect(normalizeRelativePath('./foo//bar/')).toBe('foo/bar')
    expect(normalizeRelativePath('foo\\bar\\.\\baz')).toBe('foo/bar/baz')
  })

  it('rejects parent, absolute, drive, and NUL paths', () => {
    for (const path of ['..', 'foo/../bar', 'foo/bar/..', '/etc/passwd', 'C:/Windows', 'C:foo', '\\etc\\passwd', 'a\0b']) {
      expect(() => normalizeRelativePath(path)).toThrow(PlatformError)
      try {
        normalizeRelativePath(path)
      } catch (error) {
        expect(error).toMatchObject({ name: 'PlatformError', code: 'escape' })
      }
    }
  })
})

describe('MemoryFileSystem', () => {
  it('round-trips text and bytes without sharing buffers', async () => {
    const fs = new MemoryFileSystem('vault')
    expect(fs.rootLabel).toBe('vault')
    expect(fs.capabilities.watch).toBe(true)

    await fs.writeText('notes/hello.txt', '你好\nstride')
    expect(await fs.readText('notes/hello.txt')).toBe('你好\nstride')
    expect(await fs.readText('notes\\hello.txt')).toBe('你好\nstride')
    expect((await fs.stat('notes/hello.txt'))?.size).toBe(new TextEncoder().encode('你好\nstride').byteLength)

    const payload = new Uint8Array([0, 1, 2, 255])
    await fs.writeBytes('bin/data.bin', payload)
    payload[0] = 9
    const read = await fs.readBytes('bin/data.bin')
    expect([...read]).toEqual([0, 1, 2, 255])
    read[0] = 7
    expect([...(await fs.readBytes('bin/data.bin'))]).toEqual([0, 1, 2, 255])

    await fs.writeBytes('notes/hello.txt', new Uint8Array([67]))
    expect(await fs.readText('notes/hello.txt')).toBe('C')
  })

  it('creates parent directories, lists one level sorted by name, and updates mtime', async () => {
    const fs = new MemoryFileSystem()
    await fs.mkdir('dir/m')
    await fs.writeText('dir/b.txt', 'b')
    await fs.writeText('dir/a.txt', 'a')
    await fs.mkdir('dir/c')
    expect(await fs.list('dir')).toEqual([
      { name: 'a.txt', kind: 'file' },
      { name: 'b.txt', kind: 'file' },
      { name: 'c', kind: 'directory' },
      { name: 'm', kind: 'directory' },
    ])
    expect(await fs.list('')).toEqual([{ name: 'dir', kind: 'directory' }])
    expect(await fs.stat('missing')).toBeNull()
    expect(await fs.stat('dir')).toMatchObject({ kind: 'directory', size: 0 })

    const before = (await fs.stat('dir/a.txt'))?.mtimeMs ?? 0
    await fs.writeText('dir/a.txt', 'abc')
    const after = await fs.stat('dir/a.txt')
    expect(after).toMatchObject({ kind: 'file', size: 3 })
    expect(after?.mtimeMs).toBeGreaterThan(before)

    await expect(fs.list('dir/a.txt')).rejects.toMatchObject({ code: 'io' })
    await expect(fs.list('missing')).rejects.toMatchObject({ code: 'not-found' })
    await expect(fs.readText('dir')).rejects.toMatchObject({ code: 'io' })
    await expect(fs.readBytes('missing.txt')).rejects.toMatchObject({ code: 'not-found' })
    await expect(fs.writeText('dir', 'nope')).rejects.toMatchObject({ code: 'io' })
    await fs.writeText('file-name', 'x')
    await expect(fs.mkdir('file-name/child')).rejects.toMatchObject({ code: 'io' })
  })

  it('renames files and directories, creating the destination parent', async () => {
    const fs = new MemoryFileSystem()
    await fs.writeText('old/file.txt', 'from')
    await fs.rename('old/file.txt', 'dir/sub/new.txt')
    expect(await fs.readText('dir/sub/new.txt')).toBe('from')
    expect((await fs.stat('dir/sub'))?.kind).toBe('directory')
    expect(await fs.stat('old/file.txt')).toBeNull()

    await fs.writeText('dir/sub/other.txt', 'keep')
    await fs.rename('dir/sub/new.txt', 'dir/sub/other.txt')
    expect(await fs.readText('dir/sub/other.txt')).toBe('from')
    expect(await fs.stat('dir/sub/new.txt')).toBeNull()

    await fs.rename('dir', 'moved')
    expect(await fs.readText('moved/sub/other.txt')).toBe('from')
    expect(await fs.stat('dir')).toBeNull()

    await fs.writeText('loose.txt', 'loose')
    await expect(fs.rename('loose.txt', 'moved')).rejects.toMatchObject({ code: 'already-exists' })
    expect(await fs.readText('loose.txt')).toBe('loose')
    expect(await fs.readText('moved/sub/other.txt')).toBe('from')
    await expect(fs.rename('missing.txt', 'gone.txt')).rejects.toMatchObject({ code: 'not-found' })
  })

  it('removes a tree and rejects a missing path', async () => {
    const fs = new MemoryFileSystem()
    await fs.writeText('root/a/b.txt', 'b')
    await fs.writeText('root/c.txt', 'c')
    await fs.mkdir('root/a/empty')
    await fs.remove('root')
    expect(await fs.stat('root')).toBeNull()
    expect(await fs.stat('root/a/b.txt')).toBeNull()
    expect(await fs.list('')).toEqual([])
    await expect(fs.remove('root')).rejects.toMatchObject({ code: 'not-found' })
  })

  it('rejects escape paths on filesystem operations', async () => {
    const fs = new MemoryFileSystem()
    await expect(fs.readText('..')).rejects.toMatchObject({ code: 'escape' })
    await expect(fs.readText('/etc/passwd')).rejects.toMatchObject({ code: 'escape' })
    await expect(fs.writeText('a\0b', 'x')).rejects.toMatchObject({ code: 'escape' })
    await expect(fs.rename('C:/Windows', 'notes')).rejects.toMatchObject({ code: 'escape' })
    await expect(fs.list('foo/../../etc')).rejects.toMatchObject({ code: 'escape' })
  })

  it('emits scoped watch events until unsubscribe', async () => {
    const fs = new MemoryFileSystem()
    const rootEvents: WatchEvent[] = []
    const noteEvents: WatchEvent[] = []
    const stopRoot = await fs.watch('', (event) => {
      rootEvents.push(event)
    })
    const stopNotes = await fs.watch('notes', (event) => {
      noteEvents.push(event)
    })

    await fs.mkdir('a/b/c')
    expect(rootEvents).toEqual([
      { kind: 'create', path: 'a' },
      { kind: 'create', path: 'a/b' },
      { kind: 'create', path: 'a/b/c' },
    ])

    await fs.writeText('notes\\a.txt', 'one')
    expect(rootEvents).toContainEqual({ kind: 'create', path: 'notes' })
    expect(rootEvents).toContainEqual({ kind: 'create', path: 'notes/a.txt' })
    expect(noteEvents).toEqual([
      { kind: 'create', path: 'notes' },
      { kind: 'create', path: 'notes/a.txt' },
    ])

    await fs.writeText('other/b.txt', 'b')
    expect(noteEvents.some((event) => event.path.startsWith('other'))).toBe(false)

    await fs.writeText('notes/a.txt', 'two')
    expect(noteEvents.at(-1)).toEqual({ kind: 'modify', path: 'notes/a.txt' })

    const beforeStop = rootEvents.length
    stopRoot()
    await fs.writeText('notes/a.txt', 'three')
    await fs.remove('other/b.txt')
    expect(rootEvents).toHaveLength(beforeStop)
    expect(noteEvents.at(-1)).toEqual({ kind: 'modify', path: 'notes/a.txt' })
    stopNotes()
    await fs.writeText('notes/a.txt', 'four')
    expect(noteEvents.at(-1)).toEqual({ kind: 'modify', path: 'notes/a.txt' })

    const removed: string[] = []
    await fs.watch('', (event) => {
      if (event.kind === 'remove') removed.push(event.path)
    })
    await fs.writeText('tree/b.txt', 'b')
    await fs.writeText('tree/c/d.txt', 'd')
    removed.length = 0
    await fs.remove('tree')
    expect(removed).toEqual(['tree/b.txt', 'tree/c/d.txt', 'tree/c', 'tree'])

    const renamed: WatchEvent[] = []
    await fs.watch('', (event) => {
      renamed.push(event)
    })
    await fs.writeText('old.txt', 'x')
    renamed.length = 0
    await fs.rename('old.txt', 'dest/new.txt')
    expect(renamed).toEqual([
      { kind: 'create', path: 'dest' },
      { kind: 'remove', path: 'old.txt' },
      { kind: 'create', path: 'dest/new.txt' },
    ])
  })
})
