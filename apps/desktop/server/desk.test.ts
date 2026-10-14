// @vitest-environment node
import { execFileSync } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'
import {
  APP_VERSION,
  createVaultNote,
  gitAddRemote,
  gitClone,
  gitCommit,
  gitPush,
  initGit,
  plainText,
  saveNote,
  writeSettings,
  type AppSettings,
  type GithubRelease,
} from '@stride/core'
import { NodeFileSystem, NodeGitBackend, NodeSecretsStore, gitInitBare } from '@stride/platform-node'
import { Desk } from './desk.ts'

const git = new NodeGitBackend()
const secrets = new NodeSecretsStore()

function vaultOf(dir: string): NodeFileSystem {
  return new NodeFileSystem(dir)
}

const dirs: string[] = []
const servers: http.Server[] = []
const desks: Desk[] = []

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stride-desk-'))
  dirs.push(dir)
  return dir
}

async function blankSettings(file: string, embedding?: AppSettings['embedding']) {
  await writeSettings(new NodeFileSystem(path.dirname(file)), path.basename(file), {
    embedding: embedding ?? { endpoint: '', model: '', apiKey: '', dim: 4 },
    llmConfigs: [],
    releasesUrl: '',
    gitEnabled: true,
  }, secrets)
}

function vectorFor(text: string): number[] {
  if (text.includes('alpha-note') || text.includes('nearest-alpha')) return [1, 0, 0, 0, 0, 0, 0, 0]
  return [0, 0, 0, 0, 0, 0, 0, 1]
}

async function embeddingServer(expectedKey: string): Promise<string> {
  const server = http.createServer((req, res) => {
    if ((req.headers.authorization || '') !== `Bearer ${expectedKey}`) {
      res.writeHead(401)
      res.end('bad key')
      return
    }
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(chunk as Buffer))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { input?: string[] }
      const input = body.input ?? []
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        data: input.map((text, index) => ({ index, embedding: vectorFor(text) })),
      }))
    })
  })
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no port')
  return `http://127.0.0.1:${address.port}/v1`
}

afterEach(async () => {
  await Promise.all(desks.splice(0).map(async (desk) => {
    try {
      await desk.index?.close()
    } catch {
      // The index may already be closed.
    }
  }))
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  await new Promise((resolve) => setTimeout(resolve, 30))
  for (const dir of dirs.splice(0)) execFileSync('rm', ['-rf', dir])
})

describe('Desk vault paths', () => {
  it('reloads the chosen side after resolve so a later save keeps those bytes', async () => {
    const root = tempDir()
    const vault = path.join(root, 'vault')
    fs.mkdirSync(vault)
    await initGit(vaultOf(vault), git, os.homedir())
    const note = await createVaultNote(vaultOf(vault), 'Status')
    note.doc = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'base' }] }],
    }
    await saveNote(vaultOf(vault), note)
    await gitCommit(vaultOf(vault), git, 'Add status note')
    const bare = path.join(root, 'origin.git')
    await gitInitBare(bare)
    await gitAddRemote(vaultOf(vault), git, bare)
    await gitPush(vaultOf(vault), git)
    const other = path.join(root, 'other')
    await gitClone(git, bare, other)

    const settings = path.join(root, 'settings.json')
    await blankSettings(settings)
    const desk = new Desk(settings)
    desks.push(desk)
    await desk.open(other)

    const rel = 'status.stride.json'
    const oursFile = path.join(other, rel)
    const theirsFile = path.join(vault, rel)
    const oursNote = JSON.parse(fs.readFileSync(oursFile, 'utf8')) as {
      doc: { content: { content: { text: string }[] }[] }
    }
    const theirsNote = JSON.parse(fs.readFileSync(theirsFile, 'utf8')) as typeof oursNote
    oursNote.doc.content[0]!.content[0]!.text = 'SIDE_B'
    theirsNote.doc.content[0]!.content[0]!.text = 'SIDE_A'
    fs.writeFileSync(oursFile, `${JSON.stringify(oursNote, null, 2)}\n`)
    fs.writeFileSync(theirsFile, `${JSON.stringify(theirsNote, null, 2)}\n`)
    await gitCommit(vaultOf(other), git, 'Other side')
    await gitCommit(vaultOf(vault), git, 'Vault side')
    await gitPush(vaultOf(vault), git)

    const pulled = await desk.gitPull()
    expect(pulled.conflict).toBe(true)
    expect(pulled.files).toContain(rel)

    const resolved = await desk.gitResolve(note.id, 'theirs')
    const loaded = resolved.notes.find((item) => item.id === note.id)
    expect(plainText(loaded!.doc)).toContain('SIDE_A')
    expect(plainText(loaded!.doc)).not.toContain('SIDE_B')
    expect(plainText(desk.notes.find((item) => item.id === note.id)!.doc)).toContain('SIDE_A')

    await desk.save(loaded!)
    const disk = fs.readFileSync(oursFile, 'utf8')
    expect(disk).toContain('SIDE_A')
    expect(disk).not.toContain('SIDE_B')
  }, 30000)

  it('rejects a note id that would write outside the vault', async () => {
    const root = tempDir()
    const vault = path.join(root, 'vault')
    fs.mkdirSync(vault)
    const settings = path.join(root, 'settings.json')
    await blankSettings(settings)
    const desk = new Desk(settings)
    desks.push(desk)
    await desk.open(vault)
    const outside = path.resolve(vault, '..', 'outside.stride.json')
    await expect(desk.save({
      id: '../outside',
      title: 'Escape',
      type: 'note',
      properties: {},
      doc: { type: 'doc', content: [{ type: 'paragraph' }] },
    })).rejects.toThrow(/Invalid note id|escapes the vault/)
    await expect(desk.gitResolve('../outside', 'ours')).rejects.toThrow(/Invalid note id|escapes the vault/)
    expect(fs.existsSync(outside)).toBe(false)
  })

  it('sizes the Vane collection from an 8-d embedding instead of the default dim', async () => {
    const key = 'sk-dim-test-key'
    const endpoint = await embeddingServer(key)
    const root = tempDir()
    const vault = path.join(root, 'vault')
    fs.mkdirSync(vault)
    await saveNote(vaultOf(vault), {
      id: 'alpha',
      title: 'Alpha',
      type: 'note',
      properties: {},
      doc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'alpha-note xylophonequartz' }] }] },
    })
    await saveNote(vaultOf(vault), {
      id: 'gamma',
      title: 'Gamma',
      type: 'note',
      properties: {},
      doc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'gamma-note soup recipe' }] }] },
    })
    const settings = path.join(root, 'settings.json')
    await blankSettings(settings, { endpoint, model: 'fixture-embed', apiKey: key, dim: 4 })
    const desk = new Desk(settings)
    desks.push(desk)
    await desk.open(vault)
    expect(desk.searchError).toBe('')
    expect(desk.index?.dim).toBe(8)
    const ranked = await desk.search('nearest-alpha')
    expect(ranked.mode).toBe('hybrid')
    expect(ranked.hits[0]?.id).toBe('alpha')
    expect(['alpha-note xylophonequartz', 'gamma-note soup recipe'].some((text) => text.includes('nearest-alpha'))).toBe(false)
  })

  it('rolls the version marker back when the release bytes cannot start', async () => {
    const crashes: string[] = []
    const onUncaught = (error: Error) => {
      const code = 'code' in error ? String(error.code) : ''
      crashes.push(`uncaught ${code} ${error.message}`)
    }
    const onRejection = (error: unknown) => {
      const err = error instanceof Error ? error : new Error(String(error))
      crashes.push(`rejection ${err.message}`)
    }
    process.on('uncaughtException', onUncaught)
    process.on('unhandledRejection', onRejection)
    try {
      const root = tempDir()
      const asset = Buffer.from('stride-update-bytes-v2')
      let assetUrl = ''
      const server = http.createServer((req, res) => {
        const url = new URL(req.url || '/', 'http://127.0.0.1')
        if (url.pathname === '/releases') {
          const releases: GithubRelease[] = [
            {
              tag_name: 'v0.2.0',
              draft: false,
              assets: [{ name: 'stride-0.2.0.bin', browser_download_url: assetUrl }],
            },
          ]
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify(releases))
          return
        }
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': String(asset.length),
        })
        res.end(asset)
      })
      servers.push(server)
      server.listen(0, '127.0.0.1')
      await once(server, 'listening')
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('no port')
      assetUrl = `http://127.0.0.1:${address.port}/stride-0.2.0.bin`

      const settings = path.join(root, 'settings.json')
      const marker = path.join(root, 'version-marker.txt')
      await writeSettings(new NodeFileSystem(root), 'settings.json', {
        embedding: { endpoint: '', model: '', apiKey: '', dim: 4 },
        llmConfigs: [],
        releasesUrl: `http://127.0.0.1:${address.port}/releases`,
        gitEnabled: true,
      }, secrets)
      fs.writeFileSync(marker, `${APP_VERSION}\n`)
      const handoffs: string[] = []
      const desk = new Desk(settings, { handoff: () => { handoffs.push('quit') } })
      desks.push(desk)

      const checked = await desk.checkUpdates()
      expect(checked.selected?.version).toBe('v0.2.0')
      const downloaded = await desk.downloadUpdate()
      expect(downloaded.phase).toBe('ready')
      expect(fs.readFileSync(downloaded.downloadedTo).equals(asset)).toBe(true)
      expect(fs.existsSync(desk.installPath)).toBe(false)
      expect(desk.restartRequested).toBe(false)

      await expect(desk.confirmUpdate()).rejects.toMatchObject({ code: 'ENOEXEC' })
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(crashes).toEqual([])
      expect(handoffs).toEqual([])
      expect(desk.restartRequested).toBe(false)
      expect(desk.updater.phase).toBe('available')
      expect(desk.updater.relaunchCount).toBe(0)
      expect(await desk.updater.markerValue()).toBe(APP_VERSION)
      expect(fs.readFileSync(marker, 'utf8').trim()).toBe(APP_VERSION)
      expect(fs.existsSync(desk.installPath)).toBe(false)

      const again = await desk.checkUpdates()
      expect(again.selected?.version).toBe('v0.2.0')
      expect(again.phase).toBe('available')
    } finally {
      process.off('uncaughtException', onUncaught)
      process.off('unhandledRejection', onRejection)
    }
  })

  it('does not hand off when the installed process exits immediately', async () => {
    const root = tempDir()
    const releasesUrl = await serveAsset(Buffer.from('#!/bin/sh\nexit 0\n'))
    const handoffs: string[] = []
    const { desk, marker } = await openUpdateDesk(root, releasesUrl, () => {
      handoffs.push('quit')
    })
    await desk.checkUpdates()
    await desk.downloadUpdate()
    await expect(desk.confirmUpdate()).rejects.toThrow(/exited before it stayed running/)
    expect(handoffs).toEqual([])
    expect(desk.restartRequested).toBe(false)
    expect(await desk.updater.markerValue()).toBe(APP_VERSION)
    expect(fs.readFileSync(marker, 'utf8').trim()).toBe(APP_VERSION)
    expect(fs.existsSync(desk.installPath)).toBe(false)
    const again = await desk.checkUpdates()
    expect(again.selected?.version).toBe('v0.2.0')
  }, 15000)

  it('hands off only after the installed process stays up', async () => {
    const root = tempDir()
    const releasesUrl = await serveAsset(Buffer.from('#!/bin/sh\necho $$ > "$(dirname "$0")/stride.pid"\nsleep 30\n'))
    let pid = 0
    const { desk, marker } = await openUpdateDesk(root, releasesUrl, () => {
      const pidFile = path.join(path.dirname(desk.installPath), 'stride.pid')
      pid = Number(fs.readFileSync(pidFile, 'utf8'))
      process.kill(pid, 0)
      if (fs.readFileSync(marker, 'utf8').trim() !== 'v0.2.0') {
        throw new Error('marker was not the installed version when handing off')
      }
    })
    try {
      await desk.checkUpdates()
      await desk.downloadUpdate()
      const result = await desk.confirmUpdate()
      expect(result.restartRequested).toBe(true)
      expect(pid).toBeGreaterThan(0)
      expect(await desk.updater.markerValue()).toBe('v0.2.0')
      expect(desk.updater.relaunchCount).toBe(1)
      process.kill(pid, 0)
    } finally {
      if (pid) {
        try { process.kill(-pid, 'SIGKILL') } catch { /* not a process group */ }
        try { process.kill(pid, 'SIGKILL') } catch { /* already stopped */ }
      }
    }
  }, 15000)
})

async function openUpdateDesk(root: string, releasesUrl: string, handoff: () => void | Promise<void>) {
  const settings = path.join(root, 'settings.json')
  const marker = path.join(root, 'version-marker.txt')
  await writeSettings(new NodeFileSystem(root), 'settings.json', {
    embedding: { endpoint: '', model: '', apiKey: '', dim: 4 },
    llmConfigs: [],
    releasesUrl,
    gitEnabled: true,
  }, secrets)
  fs.writeFileSync(marker, `${APP_VERSION}\n`)
  const desk = new Desk(settings, { handoff })
  desks.push(desk)
  return { desk, marker }
}

async function serveAsset(asset: Buffer): Promise<string> {
  let assetUrl = ''
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    if (url.pathname === '/releases') {
      const releases: GithubRelease[] = [
        {
          tag_name: 'v0.2.0',
          draft: false,
          assets: [{ name: 'stride-0.2.0.bin', browser_download_url: assetUrl }],
        },
      ]
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(releases))
      return
    }
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': String(asset.length),
    })
    res.end(asset)
  })
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no port')
  assetUrl = `http://127.0.0.1:${address.port}/stride-0.2.0.bin`
  return `http://127.0.0.1:${address.port}/releases`
}
