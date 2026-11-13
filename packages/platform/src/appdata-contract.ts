import { describe, expect, it } from 'vitest'
import type { AppDataStore } from './index.ts'

/**
 * Shared behavior contract for every AppDataStore implementation. Registered
 * once per adapter (memory double, electron, web fake-IDB) so all
 * three provably agree on semantics.
 */
export function registerAppDataStoreContract(
  name: string,
  create: () => AppDataStore | Promise<AppDataStore>,
): void {
  describe(`AppDataStore contract: ${name}`, () => {
    it('round-trips text and returns null for missing paths', async () => {
      const store = await create()
      expect(await store.readText('chats/v1/s1.json')).toBeNull()
      await store.writeText('chats/v1/s1.json', '{"format":1}')
      expect(await store.readText('chats/v1/s1.json')).toBe('{"format":1}')
      await store.writeText('chats/v1/s1.json', '覆盖 ✍️')
      expect(await store.readText('chats\\v1\\s1.json')).toBe('覆盖 ✍️')
      expect(await store.readText('chats/v1/missing.json')).toBeNull()
    })

    it('publishes writes atomically and never lists tmp files', async () => {
      const store = await create()
      await store.writeText('memory/_global/index.json', '{}')
      // A crash can leave a tmp file behind; it stays readable but unlisted.
      await store.writeText('memory/_global/crashed.tmp', 'partial')
      expect(await store.readText('memory/_global/crashed.tmp')).toBe('partial')
      expect(await store.list('memory/')).toEqual(['memory/_global/index.json'])
      expect(await store.list('')).toEqual(['memory/_global/index.json'])
    })

    it('appends lines in order and creates the file on first append', async () => {
      const store = await create()
      await store.appendLine('memory/v1/log.jsonl', '{"op":"write"}')
      await store.appendLine('memory/v1/log.jsonl', '{"op":"archive"}')
      expect(await store.readText('memory/v1/log.jsonl')).toBe('{"op":"write"}\n{"op":"archive"}\n')
    })

    it('lists by prefix across nesting levels', async () => {
      const store = await create()
      await store.writeText('chats/v1/a.json', 'a')
      await store.writeText('chats/v1/nested/b.json', 'b')
      await store.writeText('chats/v2/c.json', 'c')
      await store.writeText('memory/_global/log.jsonl', 'l')
      expect(await store.list('chats/v1/')).toEqual(['chats/v1/a.json', 'chats/v1/nested/b.json'])
      expect(await store.list('chats\\v1\\')).toEqual(['chats/v1/a.json', 'chats/v1/nested/b.json'])
      expect(await store.list('chats/')).toEqual(['chats/v1/a.json', 'chats/v1/nested/b.json', 'chats/v2/c.json'])
      expect(await store.list('')).toEqual([
        'chats/v1/a.json',
        'chats/v1/nested/b.json',
        'chats/v2/c.json',
        'memory/_global/log.jsonl',
      ])
      expect(await store.list('nothing/')).toEqual([])
    })

    it('removes idempotently', async () => {
      const store = await create()
      await store.writeText('chats/v1/gone.json', 'x')
      await store.remove('chats/v1/gone.json')
      expect(await store.readText('chats/v1/gone.json')).toBeNull()
      await store.remove('chats/v1/gone.json')
      await store.remove('chats/v1/never-existed.json')
    })

    it('rejects escaping paths on every method', async () => {
      const store = await create()
      const escapes = ['..', 'a/../b', '/etc/passwd', 'C:/Windows', '\\etc\\passwd', 'a\0b']
      for (const path of escapes) {
        await expect(store.readText(path)).rejects.toMatchObject({ name: 'PlatformError', code: 'escape' })
        await expect(store.writeText(path, 'x')).rejects.toMatchObject({ code: 'escape' })
        await expect(store.appendLine(path, 'x')).rejects.toMatchObject({ code: 'escape' })
        await expect(store.remove(path)).rejects.toMatchObject({ code: 'escape' })
        await expect(store.list(path)).rejects.toMatchObject({ code: 'escape' })
      }
    })

    it('rejects empty file paths but accepts an empty list prefix', async () => {
      const store = await create()
      for (const path of ['', '.']) {
        await expect(store.readText(path)).rejects.toMatchObject({ name: 'PlatformError', code: 'io' })
        await expect(store.writeText(path, 'x')).rejects.toMatchObject({ code: 'io' })
        await expect(store.appendLine(path, 'x')).rejects.toMatchObject({ code: 'io' })
        await expect(store.remove(path)).rejects.toMatchObject({ code: 'io' })
      }
      expect(await store.list('')).toEqual([])
    })
  })
}
