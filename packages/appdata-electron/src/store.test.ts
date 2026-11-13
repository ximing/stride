import { beforeEach, describe, expect, it, vi } from 'vitest'
import { registerAppDataStoreContract } from '../../platform/src/appdata-contract.ts'

const homeDir = vi.hoisted(() => vi.fn(async () => '/home/test/'))



// Minimal in-memory filesystem double with POSIX paths. Directories exist only after
// mkdir; files live in a flat map keyed by absolute path.
const plugin = vi.hoisted(() => {
  const files = new Map<string, string>()
  const dirs = new Set<string>(['/', '/home', '/home/test'])
  let renameRefusesOccupied = false

  function notFound(path: string): Error {
    return new Error(`failed to access path: ${path} with error: No such file or directory (os error 2)`)
  }

  function parentDir(path: string): string {
    const slash = path.lastIndexOf('/')
    return slash <= 0 ? '/' : path.slice(0, slash)
  }

  return {
    files,
    dirs,
    get renameRefusesOccupied() {
      return renameRefusesOccupied
    },
    set renameRefusesOccupied(value: boolean) {
      renameRefusesOccupied = value
    },
    reset() {
      files.clear()
      dirs.clear()
      dirs.add('/')
      dirs.add('/home')
      dirs.add('/home/test')
      renameRefusesOccupied = false
    },
    async mkdir(path: string): Promise<void> {
      if (files.has(path)) throw new Error(`Cannot create directory over file: ${path}`)
      let cursor = ''
      for (const part of path.split('/')) {
        if (!part) continue
        cursor = `${cursor}/${part}`
        dirs.add(cursor)
      }
    },
    async writeTextFile(path: string, text: string): Promise<void> {
      if (!dirs.has(parentDir(path))) throw notFound(path)
      files.set(path, text)
    },
    async readTextFile(path: string): Promise<string> {
      const text = files.get(path)
      if (text === undefined) throw notFound(path)
      return text
    },
    async rename(from: string, to: string): Promise<void> {
      const text = files.get(from)
      if (text === undefined) throw notFound(from)
      if (renameRefusesOccupied && files.has(to)) {
        throw new Error(`failed to rename: ${to} with error: File exists (os error 17)`)
      }
      files.delete(from)
      files.set(to, text)
    },
    async remove(path: string): Promise<void> {
      if (files.delete(path)) return
      if (dirs.delete(path)) return
      throw notFound(path)
    },
    async stat(path: string) {
      if (dirs.has(path)) return { isFile: false, isDirectory: true, isSymlink: false, size: 0, mtime: null }
      const text = files.get(path)
      if (text === undefined) throw notFound(path)
      return { isFile: true, isDirectory: false, isSymlink: false, size: text.length, mtime: null }
    },
    async readDir(path: string) {
      if (!dirs.has(path)) throw notFound(path)
      const prefix = path === '/' ? '/' : `${path}/`
      const out: Array<{ name: string; isFile: boolean; isDirectory: boolean; isSymlink: boolean }> = []
      const seen = new Set<string>()
      for (const key of [...files.keys(), ...dirs]) {
        if (key === path || !key.startsWith(prefix)) continue
        const rest = key.slice(prefix.length)
        const slash = rest.indexOf('/')
        const name = slash === -1 ? rest : rest.slice(0, slash)
        if (name === '' || seen.has(name)) continue
        seen.add(name)
        const full = `${prefix}${name}`
        out.push({ name, isFile: files.has(full), isDirectory: dirs.has(full), isSymlink: false })
      }
      return out
    },
  }
})

vi.mock('@stride/electron-api', () => ({
  homeDir,
  mkdir: plugin.mkdir,
  writeTextFile: plugin.writeTextFile,
  readTextFile: plugin.readTextFile,
  rename: plugin.rename,
  remove: plugin.remove,
  stat: plugin.stat,
  readDir: plugin.readDir,
}))

import { electronAppDataStore } from './index.ts'

beforeEach(() => {
  plugin.reset()
  homeDir.mockReset()
  homeDir.mockResolvedValue('/home/test/')
})

registerAppDataStoreContract('ElectronAppDataStore', () => electronAppDataStore())

describe('ElectronAppDataStore', () => {
  it('stores everything under the host home .stride directory', async () => {
    const store = await electronAppDataStore()
    await store.writeText('chats/v1/s.json', '{}')
    expect(plugin.files.get('/home/test/.stride/chats/v1/s.json')).toBe('{}')
    await store.appendLine('memory/_global/log.jsonl', 'l')
    expect(plugin.files.get('/home/test/.stride/memory/_global/log.jsonl')).toBe('l\n')
  })

  it('overwrites an occupied destination when rename refuses it', async () => {
    plugin.renameRefusesOccupied = true
    const store = await electronAppDataStore()
    await store.writeText('chats/v1/s.json', 'one')
    await store.writeText('chats/v1/s.json', 'two')
    expect(await store.readText('chats/v1/s.json')).toBe('two')
    expect([...plugin.files.keys()].filter((key) => key.endsWith('.tmp'))).toEqual([])
  })
})
