import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PlatformError } from '@stride/platform'
import { TauriFileSystem } from './index.ts'

interface Stored {
  kind: 'file' | 'directory' | 'symlink'
  bytes: Uint8Array
  mtimeMs: number
}

const plugin = vi.hoisted(() => {
  const calls: string[] = []
  const nodes = new Map<string, Stored>()
  let clock = 0

  function touch(): number {
    clock += 1
    return clock
  }

  function notFound(path: string): Error {
    return new Error(`failed to get metadata of path: ${path} with error: No such file or directory (os error 2)`)
  }

  function parentOf(path: string): string {
    const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
    if (slash < 0) return path
    if (slash === 0) return path[0] === '/' ? '/' : path.slice(0, 1)
    return path.slice(0, slash)
  }

  function nameOf(path: string): string {
    const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
    return path.slice(slash + 1)
  }

  function requireNode(path: string): Stored {
    const node = nodes.get(path)
    if (!node) throw notFound(path)
    return node
  }

  function putDir(path: string): void {
    const existing = nodes.get(path)
    if (existing?.kind === 'file') throw new Error(`Cannot create directory over file: ${path}`)
    if (existing?.kind === 'directory') return
    nodes.set(path, { kind: 'directory', bytes: new Uint8Array(), mtimeMs: touch() })
  }

  const api = {
    calls,
    nodes,
    statError: null as string | null,
    setStatError(message: string | null) {
      api.statError = message
    },
    reset() {
      calls.length = 0
      nodes.clear()
      clock = 0
      api.statError = null
      nodes.set('/vault', { kind: 'directory', bytes: new Uint8Array(), mtimeMs: 0 })
    },
    notFound,
    parentOf,
    nameOf,
    requireNode,
    putDir,
    touch,
  }
  return api
})

vi.mock('@tauri-apps/plugin-fs', () => ({
  async readTextFile(path: string): Promise<string> {
    plugin.calls.push(`readTextFile ${path}`)
    const node = plugin.requireNode(path)
    if (node.kind !== 'file') throw new Error(`Is a directory (os error 21): ${path}`)
    return new TextDecoder().decode(node.bytes)
  },
  async readFile(path: string): Promise<Uint8Array> {
    plugin.calls.push(`readFile ${path}`)
    const node = plugin.requireNode(path)
    if (node.kind !== 'file') throw new Error(`Is a directory (os error 21): ${path}`)
    return node.bytes.slice()
  },
  async writeTextFile(path: string, data: string): Promise<void> {
    plugin.calls.push(`writeTextFile ${path}`)
    plugin.nodes.set(path, {
      kind: 'file',
      bytes: new TextEncoder().encode(data),
      mtimeMs: plugin.touch(),
    })
  },
  async writeFile(path: string, data: Uint8Array): Promise<void> {
    plugin.calls.push(`writeFile ${path}`)
    plugin.nodes.set(path, { kind: 'file', bytes: data.slice(), mtimeMs: plugin.touch() })
  },
  async readDir(path: string) {
    plugin.calls.push(`readDir ${path}`)
    const node = plugin.requireNode(path)
    if (node.kind !== 'directory') throw new Error(`Not a directory: ${path}`)
    const entries = []
    for (const [full, child] of plugin.nodes) {
      if (plugin.parentOf(full) !== path) continue
      entries.push({
        name: plugin.nameOf(full),
        isDirectory: child.kind === 'directory',
        isFile: child.kind === 'file',
        isSymlink: child.kind === 'symlink',
      })
    }
    return entries
  },
  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    plugin.calls.push(`mkdir ${path} ${String(options?.recursive ?? false)}`)
    if (!options?.recursive) {
      const parent = plugin.requireNode(plugin.parentOf(path))
      if (parent.kind !== 'directory') throw new Error(`Not a directory: ${path}`)
      plugin.putDir(path)
      return
    }
    const chain: string[] = []
    let current = path
    while (true) {
      chain.push(current)
      const parent = plugin.parentOf(current)
      if (parent === current) break
      current = parent
    }
    for (const dir of chain.reverse()) plugin.putDir(dir)
  },
  async rename(oldPath: string, newPath: string): Promise<void> {
    plugin.calls.push(`rename ${oldPath} ${newPath}`)
    plugin.requireNode(oldPath)
    const moved: [string, Stored][] = []
    for (const [full, node] of plugin.nodes) {
      if (full === oldPath || full.startsWith(`${oldPath}/`) || full.startsWith(`${oldPath}\\`)) {
        moved.push([full, node])
      }
    }
    for (const [full] of moved) plugin.nodes.delete(full)
    for (const [full, node] of moved) {
      plugin.nodes.set(newPath + full.slice(oldPath.length), node)
    }
  },
  async remove(path: string, options?: { recursive?: boolean }): Promise<void> {
    plugin.calls.push(`remove ${path} ${String(options?.recursive ?? false)}`)
    plugin.requireNode(path)
    const drop = [...plugin.nodes.keys()].filter((full) => {
      return full === path || full.startsWith(`${path}/`) || full.startsWith(`${path}\\`)
    })
    for (const full of drop) plugin.nodes.delete(full)
  },
  async stat(path: string) {
    plugin.calls.push(`stat ${path}`)
    if (plugin.statError) throw new Error(plugin.statError)
    const node = plugin.requireNode(path)
    return {
      isFile: node.kind === 'file',
      isDirectory: node.kind === 'directory',
      isSymlink: false,
      size: node.bytes.byteLength,
      mtime: new Date(node.mtimeMs),
      atime: null,
      birthtime: null,
      readonly: false,
    }
  },
}))

beforeEach(() => {
  plugin.reset()
})

function fs(): TauriFileSystem {
  return new TauriFileSystem('/vault')
}

describe('TauriFileSystem', () => {
  it('rejects a relative root with escape', () => {
    expect(() => new TauriFileSystem('vault')).toThrow(PlatformError)
    expect(() => new TauriFileSystem('vault')).toThrow(expect.objectContaining({ code: 'escape' }))
    expect(() => new TauriFileSystem('./vault')).toThrow(expect.objectContaining({ code: 'escape' }))
    expect(() => new TauriFileSystem('')).toThrow(expect.objectContaining({ code: 'escape' }))
    expect(plugin.calls).toEqual([])
  })

  it('keeps an absolute root unchanged', () => {
    expect(new TauriFileSystem('/vault').rootLabel).toBe('/vault')
    expect(new TauriFileSystem('/vault').capabilities.watch).toBe(false)
    expect(new TauriFileSystem('C:\\Vault').rootLabel).toBe('C:\\Vault')
    expect(new TauriFileSystem('\\\\server\\share').rootLabel).toBe('\\\\server\\share')
    expect(new TauriFileSystem('/vault/../kept').rootLabel).toBe('/vault/../kept')
  })

  it('round-trips text and bytes', async () => {
    const backend = fs()
    await backend.writeText('notes/hello.txt', '你好\nstride')
    expect(await backend.readText('notes/hello.txt')).toBe('你好\nstride')
    expect(await backend.readText('notes\\hello.txt')).toBe('你好\nstride')

    const payload = new Uint8Array([0, 1, 2, 255])
    await backend.writeBytes('bin/data.bin', payload)
    payload[0] = 9
    const read = await backend.readBytes('bin/data.bin')
    expect([...read]).toEqual([0, 1, 2, 255])
    expect(plugin.calls).toContain('writeTextFile /vault/notes/hello.txt')
    expect(plugin.calls).toContain('readFile /vault/bin/data.bin')
  })

  it('creates parent directories before write and lists one level sorted by name', async () => {
    const backend = fs()
    await backend.writeText('dir/b.txt', 'b')
    await backend.writeText('dir/a.txt', 'a')
    await backend.mkdir('dir/m')
    await backend.mkdir('dir/c')
    await backend.writeText('dir/A', 'A')
    plugin.nodes.set('/vault/dir/link', { kind: 'symlink', bytes: new Uint8Array(), mtimeMs: 1 })
    expect(await backend.list('dir')).toEqual([
      { name: 'A', kind: 'file' },
      { name: 'a.txt', kind: 'file' },
      { name: 'b.txt', kind: 'file' },
      { name: 'c', kind: 'directory' },
      { name: 'm', kind: 'directory' },
    ])
    expect(plugin.calls.some((call) => call.startsWith('readDir /vault/dir'))).toBe(true)
    expect(plugin.calls).toContain('mkdir /vault/dir/m true')
    expect(plugin.calls).toContain('mkdir /vault/dir true')
    expect(plugin.calls).not.toContain('mkdir /vault/dir/b.txt true')
    await backend.mkdir('dir')
    expect(plugin.calls.filter((call) => call.startsWith('mkdir /vault/dir '))).toHaveLength(1)
  })

  it('returns null for a missing stat and maps other plugin failures to io', async () => {
    const backend = fs()
    expect(await backend.stat('missing')).toBeNull()
    await backend.writeText('note.txt', 'abc')
    expect(await backend.stat('note.txt')).toMatchObject({ kind: 'file', size: 3 })
    expect(await backend.stat('')).toMatchObject({ kind: 'directory', size: 0 })
    plugin.setStatError('permission denied (os error 13)')
    await expect(backend.stat('note.txt')).rejects.toMatchObject({ code: 'io' })
  })

  it('removes recursively and renames', async () => {
    const backend = fs()
    await backend.writeText('dir/a.txt', 'a')
    await backend.rename('dir/a.txt', 'dir/b.txt')
    expect(await backend.readText('dir/b.txt')).toBe('a')
    expect(await backend.stat('dir/a.txt')).toBeNull()
    expect(plugin.calls).toContain('rename /vault/dir/a.txt /vault/dir/b.txt')
    await backend.remove('dir')
    expect(await backend.stat('dir/b.txt')).toBeNull()
    expect(await backend.stat('dir')).toBeNull()
    expect(plugin.calls).toContain('remove /vault/dir true')
    await expect(backend.remove('dir')).rejects.toMatchObject({ code: 'not-found' })
    await expect(backend.rename('missing', 'other')).rejects.toMatchObject({ code: 'not-found' })
    expect(plugin.calls.filter((call) => call.startsWith('rename /vault/missing'))).toEqual([])
  })

  it('maps missing reads and lists to not-found', async () => {
    const backend = fs()
    await expect(backend.readText('nope.txt')).rejects.toMatchObject({ code: 'not-found' })
    await expect(backend.readBytes('nope.txt')).rejects.toMatchObject({ code: 'not-found' })
    await expect(backend.list('missing')).rejects.toMatchObject({ code: 'not-found' })
    await backend.writeText('file.txt', 'x')
    await expect(backend.list('file.txt')).rejects.toMatchObject({ code: 'io' })
    await expect(backend.readText('')).rejects.toMatchObject({ code: 'io' })
  })

  it('rejects escape paths before calling the plugin', async () => {
    const backend = fs()
    plugin.calls.length = 0
    const paths = ['../x', '/etc/passwd', 'C:/Windows', 'foo/../../x', 'a\0b', '..\\x']
    for (const path of paths) {
      await expect(backend.readText(path)).rejects.toMatchObject({ code: 'escape' })
      await expect(backend.writeBytes(path, new Uint8Array())).rejects.toMatchObject({ code: 'escape' })
      await expect(backend.list(path)).rejects.toMatchObject({ code: 'escape' })
      await expect(backend.remove(path)).rejects.toMatchObject({ code: 'escape' })
      await expect(backend.watch(path, () => {})).rejects.toMatchObject({ code: 'escape' })
    }
    expect(plugin.calls).toEqual([])
  })

  it('joins windows separators and watches as a no-op', async () => {
    const windows = new TauriFileSystem('C:\\vault')
    await windows.writeText('a/b.txt', 'x')
    expect(plugin.calls).toContain('writeTextFile C:\\vault\\a\\b.txt')
    const posixDrive = new TauriFileSystem('C:/vault')
    await posixDrive.writeText('a.txt', 'x')
    expect(plugin.calls).toContain('writeTextFile C:/vault/a.txt')
    const unc = new TauriFileSystem('\\\\server\\share')
    await unc.writeBytes('a/b.bin', new Uint8Array([1]))
    expect(plugin.calls).toContain('writeFile \\\\server\\share\\a\\b.bin')
    const slashed = new TauriFileSystem('/vault/')
    await slashed.writeText('a.txt', 'x')
    expect(plugin.calls).toContain('writeTextFile /vault/a.txt')
    expect(plugin.calls).not.toContain('writeTextFile /vault//a.txt')
    const stop = await fs().watch('notes', () => {})
    expect(stop()).toBeUndefined()
  })
})
