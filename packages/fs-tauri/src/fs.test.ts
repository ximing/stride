import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PlatformError } from '@stride/platform'
import { TauriFileSystem } from './index.ts'

interface Stored {
  kind: 'file' | 'directory' | 'symlink'
  bytes: Uint8Array
  mtimeMs: number
  target?: string
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

  function hasChild(path: string): boolean {
    for (const full of nodes.keys()) {
      if (full.startsWith(`${path}/`) || full.startsWith(`${path}\\`)) return true
    }
    return false
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

  function splitAbsolute(path: string): { prefix: string; parts: string[]; sep: '\\' | '/' } {
    if (path.startsWith('\\\\')) {
      const bits = path.split('\\').filter((part) => part.length > 0)
      return { prefix: `\\\\${bits[0] ?? ''}\\${bits[1] ?? ''}`, parts: bits.slice(2), sep: '\\' }
    }
    if (/^[A-Za-z]:/.test(path)) {
      const sep: '\\' | '/' = path.includes('\\') ? '\\' : '/'
      const body = path.slice(2)
      const stripped = body.startsWith('/') || body.startsWith('\\') ? body.slice(1) : body
      return { prefix: path.slice(0, 2), parts: stripped.split(sep).filter((part) => part.length > 0), sep }
    }
    return { prefix: '', parts: path.split('/').filter((part) => part.length > 0), sep: '/' }
  }

  function joinAbsolute(prefix: string, parts: string[], sep: '\\' | '/'): string {
    if (prefix === '') return `/${parts.join('/')}`
    if (parts.length === 0) return prefix
    return `${prefix}${sep}${parts.join(sep)}`
  }

  function joinOnto(target: string, rest: string[]): string {
    if (rest.length === 0) return target
    const sep: '\\' | '/' = target.includes('\\') ? '\\' : '/'
    const suffix = rest.join(sep)
    if (target.endsWith('/') || target.endsWith('\\')) return `${target}${suffix}`
    return `${target}${sep}${suffix}`
  }

  // Follows symlink components the way the plugin opens a path. `followFinal`
  // is false for lstat, which keeps the last component itself.
  function locate(path: string, followFinal: boolean): string {
    let current = path
    const seen = new Set<string>()
    for (let hop = 0; hop < 40; hop += 1) {
      const { prefix, parts, sep } = splitAbsolute(current)
      let redirected = false
      for (let index = 0; index < parts.length; index += 1) {
        const cursor = joinAbsolute(prefix, parts.slice(0, index + 1), sep)
        const node = nodes.get(cursor)
        const isLast = index === parts.length - 1
        if (node?.kind !== 'symlink' || (isLast && !followFinal)) continue
        if (!node.target) throw new Error(`symlink has no target: ${cursor}`)
        if (seen.has(cursor)) throw new Error(`symlink loop: ${cursor}`)
        seen.add(cursor)
        current = joinOnto(node.target, parts.slice(index + 1))
        redirected = true
        break
      }
      if (!redirected) return joinAbsolute(prefix, parts, sep)
    }
    throw new Error(`symlink loop: ${path}`)
  }

  const api = {
    calls,
    nodes,
    statError: null as string | null,
    lstatRootSymlink: false,
    windowsRename: false,
    failRename: null as ((oldPath: string, newPath: string) => boolean) | null,
    setStatError(message: string | null) {
      api.statError = message
    },
    reset() {
      calls.length = 0
      nodes.clear()
      clock = 0
      api.statError = null
      api.lstatRootSymlink = false
      api.windowsRename = false
      api.failRename = null
      nodes.set('/vault', { kind: 'directory', bytes: new Uint8Array(), mtimeMs: 0 })
    },
    notFound,
    parentOf,
    nameOf,
    hasChild,
    requireNode,
    putDir,
    touch,
    locate,
  }
  return api
})

vi.mock('@tauri-apps/plugin-fs', () => ({
  async readTextFile(path: string): Promise<string> {
    plugin.calls.push(`readTextFile ${path}`)
    const resolved = plugin.locate(path, true)
    const node = plugin.requireNode(resolved)
    if (node.kind !== 'file') throw new Error(`Is a directory (os error 21): ${path}`)
    return new TextDecoder().decode(node.bytes)
  },
  async readFile(path: string): Promise<Uint8Array> {
    plugin.calls.push(`readFile ${path}`)
    const resolved = plugin.locate(path, true)
    const node = plugin.requireNode(resolved)
    if (node.kind !== 'file') throw new Error(`Is a directory (os error 21): ${path}`)
    return node.bytes.slice()
  },
  async writeTextFile(path: string, data: string, options?: { createNew?: boolean }): Promise<void> {
    plugin.calls.push(`writeTextFile ${path}`)
    const resolved = plugin.locate(path, true)
    if (options?.createNew && plugin.nodes.has(resolved)) {
      throw new Error(`File exists (os error 17): ${path}`)
    }
    plugin.nodes.set(resolved, {
      kind: 'file',
      bytes: new TextEncoder().encode(data),
      mtimeMs: plugin.touch(),
    })
  },
  async writeFile(path: string, data: Uint8Array, options?: { createNew?: boolean }): Promise<void> {
    plugin.calls.push(`writeFile ${path}`)
    const resolved = plugin.locate(path, true)
    if (options?.createNew && plugin.nodes.has(resolved)) {
      throw new Error(`File exists (os error 17): ${path}`)
    }
    plugin.nodes.set(resolved, { kind: 'file', bytes: data.slice(), mtimeMs: plugin.touch() })
  },
  async readDir(path: string) {
    plugin.calls.push(`readDir ${path}`)
    const resolved = plugin.locate(path, true)
    const node = plugin.requireNode(resolved)
    if (node.kind !== 'directory') throw new Error(`Not a directory: ${path}`)
    const entries = []
    for (const [full, child] of plugin.nodes) {
      if (plugin.parentOf(full) !== resolved) continue
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
    const resolved = plugin.locate(path, true)
    if (!options?.recursive) {
      const parent = plugin.requireNode(plugin.parentOf(resolved))
      if (parent.kind !== 'directory') throw new Error(`Not a directory: ${path}`)
      plugin.putDir(resolved)
      return
    }
    const chain: string[] = []
    let current = resolved
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
    const source = plugin.requireNode(oldPath)
    if (plugin.failRename?.(oldPath, newPath)) {
      throw new Error('failed to rename path with error: Access is denied. (os error 5)')
    }
    const dest = plugin.nodes.get(newPath)
    if (dest && plugin.windowsRename) {
      throw new Error('Cannot create a file when that file already exists. (os error 183)')
    }
    if (dest?.kind === 'directory') {
      if (plugin.hasChild(newPath)) throw new Error('Directory not empty (os error 66)')
      if (source.kind !== 'directory') throw new Error('Is a directory (os error 21)')
    } else if (dest && source.kind === 'directory') {
      throw new Error('Not a directory (os error 20)')
    }
    if (dest && oldPath !== newPath) plugin.nodes.delete(newPath)
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
    const node = plugin.requireNode(plugin.locate(path, true))
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
  async lstat(path: string) {
    plugin.calls.push(`lstat ${path}`)
    if (plugin.lstatRootSymlink && (path === '/vault' || path === '/vault/')) {
      return {
        isFile: false,
        isDirectory: false,
        isSymlink: true,
        size: 0,
        mtime: new Date(0),
        atime: null,
        birthtime: null,
        readonly: false,
      }
    }
    const node = plugin.requireNode(plugin.locate(path, false))
    return {
      isFile: node.kind === 'file',
      isDirectory: node.kind === 'directory',
      isSymlink: node.kind === 'symlink',
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

function published(command: 'writeTextFile' | 'writeFile', destination: string): boolean {
  const direct = plugin.calls.includes(`${command} ${destination}`)
  const wroteTemp = plugin.calls.some((call) => {
    if (!call.startsWith(`${command} `)) return false
    const path = call.slice(command.length + 1)
    return path.startsWith(`${destination}.`) && path.endsWith('.stride-w')
  })
  const renamed = plugin.calls.some((call) => {
    if (!call.startsWith('rename ')) return false
    const rest = call.slice('rename '.length)
    const marker = ` ${destination}`
    if (!rest.endsWith(marker)) return false
    const from = rest.slice(0, -marker.length)
    return from.startsWith(`${destination}.`) && from.endsWith('.stride-w')
  })
  return wroteTemp && renamed && !direct
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
    expect(published('writeTextFile', '/vault/notes/hello.txt')).toBe(true)
    expect(plugin.calls).toContain('readFile /vault/bin/data.bin')
    expect(published('writeFile', '/vault/bin/data.bin')).toBe(true)
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
    expect(published('writeTextFile', 'C:\\vault\\a\\b.txt')).toBe(true)
    const posixDrive = new TauriFileSystem('C:/vault')
    await posixDrive.writeText('a.txt', 'x')
    expect(published('writeTextFile', 'C:/vault/a.txt')).toBe(true)
    const unc = new TauriFileSystem('\\\\server\\share')
    await unc.writeBytes('a/b.bin', new Uint8Array([1]))
    expect(published('writeFile', '\\\\server\\share\\a\\b.bin')).toBe(true)
    const slashed = new TauriFileSystem('/vault/')
    await slashed.writeText('a.txt', 'x')
    expect(published('writeTextFile', '/vault/a.txt')).toBe(true)
    expect(plugin.calls).not.toContain('writeTextFile /vault//a.txt')
    const stop = await fs().watch('notes', () => {})
    expect(stop()).toBeUndefined()
  })

  it('keeps the previous file when a temp write fails', async () => {
    const backend = fs()
    await backend.writeText('notes/hello.txt', 'old')
    plugin.failRename = () => true
    await expect(backend.writeText('notes/hello.txt', 'new')).rejects.toMatchObject({ code: 'io' })
    expect(await backend.readText('notes/hello.txt')).toBe('old')
    expect(plugin.calls.includes('writeTextFile /vault/notes/hello.txt')).toBe(false)
  })

  it('replaces a file on Windows when rename returns os error 183', async () => {
    const backend = fs()
    await backend.writeText('keep.txt', 'new')
    await backend.writeText('live.txt', 'old')
    plugin.windowsRename = true
    await backend.rename('keep.txt', 'live.txt')
    expect(await backend.readText('live.txt')).toBe('new')
    expect(await backend.stat('keep.txt')).toBeNull()
    const attempts = plugin.calls.filter((call) => call === 'rename /vault/keep.txt /vault/live.txt')
    expect(attempts.length).toBeGreaterThanOrEqual(2)
  })

  it('keeps both files when a Windows replace cannot park the destination', async () => {
    const backend = fs()
    await backend.writeText('keep.txt', 'new')
    await backend.writeText('live.txt', 'old')
    plugin.windowsRename = true
    plugin.failRename = (_oldPath, newPath) => newPath.includes('.stride-bak')
    await expect(backend.rename('keep.txt', 'live.txt')).rejects.toMatchObject({ code: 'io' })
    expect(await backend.readText('live.txt')).toBe('old')
    expect(await backend.readText('keep.txt')).toBe('new')
  })

  it('restores the destination when the Windows commit rename fails', async () => {
    const backend = fs()
    await backend.writeText('keep.txt', 'new')
    await backend.writeText('live.txt', 'old')
    plugin.windowsRename = true
    let commit = 0
    plugin.failRename = (oldPath, newPath) => {
      if (!oldPath.endsWith('/vault/keep.txt') || !newPath.endsWith('/vault/live.txt')) return false
      commit += 1
      return commit > 1
    }
    await expect(backend.rename('keep.txt', 'live.txt')).rejects.toMatchObject({ code: 'io' })
    expect(await backend.readText('live.txt')).toBe('old')
    expect(await backend.readText('keep.txt')).toBe('new')
  })

  it('returns already-exists for a non-empty directory on Unix and Windows', async () => {
    const backend = fs()
    await backend.writeText('dir/a.txt', 'a')
    await backend.writeText('file.txt', 'f')
    await backend.mkdir('empty')
    await expect(backend.rename('file.txt', 'dir')).rejects.toMatchObject({ code: 'already-exists' })
    expect(await backend.readText('file.txt')).toBe('f')
    expect(await backend.readText('dir/a.txt')).toBe('a')

    plugin.windowsRename = true
    await expect(backend.rename('file.txt', 'dir')).rejects.toMatchObject({ code: 'already-exists' })
    expect(await backend.readText('file.txt')).toBe('f')
    expect(await backend.readText('dir/a.txt')).toBe('a')
    expect(await backend.stat('empty')).toMatchObject({ kind: 'directory' })
  })

  it('replaces an empty directory and overwrites a file without truncating it first', async () => {
    const backend = fs()
    await backend.mkdir('empty')
    await backend.writeText('file.txt', 'body')
    await backend.rename('file.txt', 'empty')
    expect(await backend.readText('empty')).toBe('body')
    expect(await backend.stat('file.txt')).toBeNull()

    await backend.writeText('again.txt', 'windows')
    plugin.windowsRename = true
    await backend.rename('again.txt', 'empty')
    expect(await backend.readText('empty')).toBe('windows')
    expect(await backend.stat('again.txt')).toBeNull()

    plugin.calls.length = 0
    await backend.writeText('empty', 'next')
    expect(await backend.readText('empty')).toBe('next')
    expect(published('writeTextFile', '/vault/empty')).toBe(true)

    plugin.failRename = (_oldPath, newPath) => newPath.includes('.stride-bak')
    await expect(backend.writeText('empty', 'lost')).rejects.toMatchObject({ code: 'io' })
    expect(await backend.readText('empty')).toBe('next')
    expect(plugin.calls.includes('writeTextFile /vault/empty')).toBe(false)
  })

  it('refuses symlink components whose target is outside the vault prefix', async () => {
    const backend = fs()
    const outside = '/outside'
    const underVault = (target: string) => target === '/vault' || target.startsWith('/vault/')
    expect(underVault(outside)).toBe(false)
    expect(underVault('/outside/secret.txt')).toBe(false)
    plugin.nodes.set(outside, { kind: 'directory', bytes: new Uint8Array(), mtimeMs: 1 })
    plugin.nodes.set('/outside/secret.txt', {
      kind: 'file',
      bytes: new TextEncoder().encode('secret'),
      mtimeMs: 1,
    })
    plugin.nodes.set('/vault/link', {
      kind: 'symlink',
      target: outside,
      bytes: new Uint8Array(),
      mtimeMs: 1,
    })
    plugin.nodes.set('/vault/alias.txt', {
      kind: 'symlink',
      target: '/outside/secret.txt',
      bytes: new Uint8Array(),
      mtimeMs: 1,
    })
    await backend.mkdir('dir')
    plugin.nodes.set('/vault/dir/link', {
      kind: 'symlink',
      target: outside,
      bytes: new Uint8Array(),
      mtimeMs: 1,
    })
    expect(plugin.locate('/vault/link/nested/owned.txt', true)).toBe('/outside/nested/owned.txt')
    expect(plugin.locate('/vault/dir/link/file.txt', true)).toBe('/outside/file.txt')
    expect(plugin.locate('/vault/alias.txt', true)).toBe('/outside/secret.txt')

    const { writeTextFile } = await import('@tauri-apps/plugin-fs')
    await writeTextFile('/vault/link/probe.txt', 'pwned')
    expect(new TextDecoder().decode(plugin.nodes.get('/outside/probe.txt')?.bytes)).toBe('pwned')
    plugin.nodes.delete('/outside/probe.txt')
    plugin.calls.length = 0

    await expect(backend.stat('link')).rejects.toMatchObject({ code: 'escape' })
    await expect(backend.stat('link/secret.txt')).rejects.toMatchObject({ code: 'escape' })
    await expect(backend.readText('link/secret.txt')).rejects.toMatchObject({ code: 'escape' })
    await expect(backend.readBytes('alias.txt')).rejects.toMatchObject({ code: 'escape' })
    await expect(backend.list('link')).rejects.toMatchObject({ code: 'escape' })
    await expect(backend.writeText('link/nested/owned.txt', 'pwned')).rejects.toMatchObject({ code: 'escape' })
    await expect(backend.writeBytes('alias.txt', new Uint8Array([1]))).rejects.toMatchObject({ code: 'escape' })
    await expect(backend.writeText('dir/link/file.txt', 'pwned')).rejects.toMatchObject({ code: 'escape' })

    expect(plugin.nodes.has('/outside/nested')).toBe(false)
    expect(plugin.nodes.has('/outside/nested/owned.txt')).toBe(false)
    expect(plugin.nodes.has('/outside/file.txt')).toBe(false)
    expect(plugin.nodes.has('/outside/probe.txt')).toBe(false)
    expect(new TextDecoder().decode(plugin.nodes.get('/outside/secret.txt')?.bytes)).toBe('secret')
    expect(plugin.nodes.get('/vault/alias.txt')?.kind).toBe('symlink')
    expect(plugin.calls.some((call) => call.includes('/outside'))).toBe(false)
    expect(await backend.list('dir')).toEqual([])
  })

  it('does not refuse a vault whose opened root is itself a symlink', async () => {
    plugin.lstatRootSymlink = true
    const backend = fs()
    expect(await backend.stat('')).toMatchObject({ kind: 'directory' })
    await backend.writeText('note.txt', 'kept')
    expect(await backend.readText('note.txt')).toBe('kept')
    expect(await backend.readBytes('note.txt')).toEqual(new TextEncoder().encode('kept'))
    expect(plugin.nodes.get('/vault/note.txt')?.kind).toBe('file')
    expect(plugin.calls.some((call) => call === 'lstat /vault' || call === 'lstat /vault/')).toBe(false)
  })
})
