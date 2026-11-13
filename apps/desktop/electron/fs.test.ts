// @vitest-environment node
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { registerHostFs, type HostIpcEvent, type HostSender, type HostWindow, type OpenDialogResult } from './fs.ts'
import type { RendererTrust } from './security.ts'

const DEV = 'http://127.0.0.1:1421/'
const trust: RendererTrust = { packaged: false, devUrl: DEV }

interface SentEvent {
  channel: string
  payload: unknown
}

function createSender(url = DEV) {
  const destroyedListeners: Array<() => void> = []
  let destroyed = false
  const sent: SentEvent[] = []
  const sender: HostSender = {
    getURL: () => url,
    send(channel, payload) {
      sent.push({ channel, payload })
    },
    on(event, listener) {
      if (event === 'destroyed') destroyedListeners.push(listener)
    },
    isDestroyed: () => destroyed,
  }
  return {
    sender,
    sent,
    destroy() {
      destroyed = true
      for (const listener of destroyedListeners) listener()
    },
  }
}

function eventFor(sender: HostSender): HostIpcEvent {
  return { sender }
}

describe('host filesystem primitives', () => {
  let root = ''
  let handlers: Map<string, (event: HostIpcEvent, payload?: unknown) => unknown>
  let dialogWindow: HostWindow | null
  let dialogResult: OpenDialogResult
  let dialogOptions: { properties: string[] } | null
  let home = homedir()
  let senderState = createSender()

  beforeEach(async () => {
    senderState = createSender()
    root = await mkdtemp(join(tmpdir(), 'stride-e02a-'))
    handlers = new Map()
    dialogWindow = { isDestroyed: () => false }
    dialogResult = { canceled: false, filePaths: ['/tmp/chosen'] }
    dialogOptions = null
    home = homedir()
    registerHostFs({
      handle(channel, listener) {
        handlers.set(channel, listener)
      },
      getTrust: () => trust,
      homedir: () => home,
      showOpenDialog: async (window, options) => {
        dialogWindow = window
        dialogOptions = options
        return dialogResult
      },
      windowFromSender: () => dialogWindow,
    })
  })

  afterEach(async () => {
    senderState.destroy()
    if (root) await rm(root, { recursive: true, force: true })
  })

  function call(channel: string, payload?: unknown, sender = senderState.sender) {
    const handler = handlers.get(channel)
    if (!handler) throw new Error(`missing ${channel}`)
    return handler(eventFor(sender), payload)
  }

  it('registers every filesystem channel behind the trusted-sender check', () => {
    expect([...handlers.keys()].sort()).toEqual([
      'dialog:pickDirectory',
      'fs:list',
      'fs:lstat',
      'fs:mkdir',
      'fs:readBytes',
      'fs:readText',
      'fs:remove',
      'fs:rename',
      'fs:stat',
      'fs:unwatch',
      'fs:watch',
      'fs:writeBytes',
      'fs:writeText',
      'host:home',
    ])
  })

  it('round-trips text and bytes and rejects a relative or NUL path', async () => {
    const file = join(root, 'note.txt')
    await call('fs:writeText', { path: file, data: '雪 note' })
    await expect(call('fs:readText', { path: file })).resolves.toBe('雪 note')
    const bytes = [0, 255, 10, 32]
    await call('fs:writeBytes', { path: join(root, 'bin.dat'), data: bytes })
    const encoded = await call('fs:readBytes', { path: join(root, 'bin.dat') })
    expect(typeof encoded).toBe('string')
    await call('fs:writeBytes', { path: join(root, 'b64.dat'), data: encoded })
    await expect(call('fs:readBytes', { path: join(root, 'b64.dat') })).resolves.toBe(encoded)

    await expect(call('fs:readText', { path: 'relative.txt' })).rejects.toThrow(/Rejected path/)
    await expect(call('fs:writeText', { path: `${root}/\0hidden`, data: 'x' })).rejects.toThrow(/Rejected path/)
    const evil = createSender('https://evil.example/')
    await expect(call('fs:readText', { path: file }, evil.sender)).rejects.toThrow(/untrusted renderer/)
  })

  it('fails createNew with the native EEXIST error and does not invent an os error string', async () => {
    const file = join(root, 'once.txt')
    await call('fs:writeText', { path: file, data: 'a', createNew: true })
    await expect(call('fs:writeText', { path: file, data: 'b', createNew: true })).rejects.toMatchObject({ code: 'EEXIST' })
    try {
      await call('fs:writeText', { path: file, data: 'b', createNew: true })
    } catch (error) {
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).not.toMatch(/os error 2/)
    }
    await expect(call('fs:readText', { path: file })).resolves.toBe('a')
    await expect(call('fs:readText', { path: join(root, 'missing.txt') })).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('lists, stats, follows only stat, and renames, mkdirs, and removes', async () => {
    const dir = join(root, 'nested', 'dir')
    await call('fs:mkdir', { path: dir, recursive: true })
    const target = join(dir, 'file.txt')
    await call('fs:writeText', { path: target, data: 'hello' })
    const link = join(dir, 'link.txt')
    await symlink(target, link)
    const listed = await call('fs:list', { path: dir }) as Array<{ name: string; isFile: boolean; isDirectory: boolean; isSymlink: boolean }>
    expect(listed).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'file.txt', isFile: true, isDirectory: false, isSymlink: false }),
      expect.objectContaining({ name: 'link.txt', isFile: false, isDirectory: false, isSymlink: true }),
    ]))
    const followed = await call('fs:stat', { path: link }) as { isFile: boolean; isSymlink: boolean; size: number }
    const linked = await call('fs:lstat', { path: link }) as { isFile: boolean; isDirectory: boolean; isSymlink: boolean }
    expect(followed.isFile).toBe(true)
    expect(followed.isSymlink).toBe(false)
    expect(followed.size).toBe(5)
    expect(linked).toMatchObject({ isFile: false, isDirectory: false, isSymlink: true })

    const moved = join(root, 'nested', 'moved.txt')
    await call('fs:rename', { oldPath: target, newPath: moved })
    await expect(call('fs:readText', { path: moved })).resolves.toBe('hello')
    await expect(call('fs:remove', { path: dir })).rejects.toMatchObject({ code: 'ENOTEMPTY' })
    await call('fs:remove', { path: join(root, 'nested'), recursive: true })
    await expect(call('fs:stat', { path: join(root, 'nested') })).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('reports an external change with an absolute path and stops after unwatch or sender destruction', async () => {
    const watched = join(root, 'watched.txt')
    await writeFile(watched, 'before')
    const started = await call('fs:watch', { path: root }) as { id: number }
    await writeFile(watched, 'after')
    const created = join(root, 'fresh.txt')
    await writeFile(created, 'new')
    const event = await waitForEvent(senderState.sent, started.id)
    expect(event).toMatchObject({ channel: 'fs:event' })
    const payload = event.payload as { id: number; path: string; kind: string }
    expect(payload.id).toBe(started.id)
    expect(payload.path.startsWith(root)).toBe(true)
    expect(['create', 'modify', 'remove']).toContain(payload.kind)
    expect(senderState.sent.some((entry) => {
      const body = entry.payload as { path?: string }
      return body.path === watched && (entry.payload as { kind: string }).kind === 'create'
    })).toBe(false)

    await call('fs:unwatch', { id: started.id })
    const before = senderState.sent.length
    await writeFile(join(root, 'after-stop.txt'), 'x')
    await delay(350)
    expect(senderState.sent.length).toBe(before)
    await expect(call('fs:unwatch', { id: started.id })).rejects.toThrow(/unknown watch/)

    const again = await call('fs:watch', { path: root }) as { id: number }
    senderState.destroy()
    await delay(50)
    await writeFile(join(root, 'after-destroy.txt'), 'x')
    await delay(350)
    expect(senderState.sent.some((entry) => (entry.payload as { id?: number }).id === again.id)).toBe(false)
    await expect(call('fs:unwatch', { id: again.id })).rejects.toThrow(/unknown watch/)
  }, 15000)

  it('rejects a watch whose id was removed before ready', async () => {
    const early = createSender()
    const hostOn = early.sender.on.bind(early.sender)
    early.sender.on = (event, listener) => {
      hostOn(event, listener)
      if (event === 'destroyed') queueMicrotask(() => early.destroy())
    }
    await expect(call('fs:watch', { path: root }, early.sender)).rejects.toThrow(/Watch closed before it was ready|Watch failed/)
    await writeFile(join(root, 'never.txt'), 'x')
    await delay(300)
    expect(early.sent).toEqual([])
  }, 15000)

  it('returns the chosen directory, null when the dialog is canceled, and a non-empty home', async () => {
    const window = { isDestroyed: () => false }
    dialogWindow = window
    dialogResult = { canceled: false, filePaths: ['/tmp/vault'] }
    await expect(call('dialog:pickDirectory')).resolves.toBe('/tmp/vault')
    expect(dialogWindow).toBe(window)
    expect(dialogOptions).toEqual({ properties: ['openDirectory', 'createDirectory'] })
    dialogResult = { canceled: true, filePaths: [] }
    await expect(call('dialog:pickDirectory')).resolves.toBeNull()
    dialogResult = { canceled: false, filePaths: [] }
    await expect(call('dialog:pickDirectory')).resolves.toBeNull()
    await expect(call('host:home')).resolves.toBe(homedir())
    home = ''
    await expect(call('host:home')).rejects.toThrow(/empty/)
    const evil = createSender('https://evil.example/')
    dialogOptions = null
    await expect(call('dialog:pickDirectory', undefined, evil.sender)).rejects.toThrow(/untrusted renderer/)
    expect(dialogOptions).toBeNull()
  })
})

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForEvent(sent: SentEvent[], id: number): Promise<SentEvent> {
  const start = Date.now()
  while (Date.now() - start < 4000) {
    const found = sent.find((entry) => (entry.payload as { id?: number }).id === id)
    if (found) return found
    await delay(20)
  }
  throw new Error('timed out waiting for fs:event')
}
