import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  gitAddRemote,
  gitClone,
  gitCommit,
  gitDiff,
  gitHistory,
  gitInitBare,
  gitPull,
  gitPush,
  gitResolve,
  gitStatus,
  initGit,
} from './git.ts'
import { DEDICATED_ERROR, isBroadPersonalRoot } from './roots.ts'
import { createVaultNote, isDedicatedVault, markDedicatedVault, saveNote } from './vault.ts'

const dirs: string[] = []

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stride-git-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('vault git', () => {
  it('refuses a broad personal root, then commits, diffs, and resolves a diverged pull', async () => {
    const root = tempDir()
    const documents = path.join(root, 'Documents')
    fs.mkdirSync(documents)
    fs.writeFileSync(path.join(documents, 'loose.txt'), 'not a vault')
    await expect(initGit(documents)).rejects.toThrow(DEDICATED_ERROR)
    expect(fs.existsSync(path.join(documents, '.git'))).toBe(false)

    expect(isBroadPersonalRoot(os.homedir(), os.homedir())).toBe(true)
    if (!isDedicatedVault(os.homedir())) {
      await expect(initGit(os.homedir())).rejects.toThrow(DEDICATED_ERROR)
    }

    const marked = path.join(root, 'Downloads')
    fs.mkdirSync(marked)
    markDedicatedVault(marked)
    await initGit(marked)
    expect(fs.existsSync(path.join(marked, '.git'))).toBe(true)

    const vault = path.join(root, 'dedicated-vault')
    fs.mkdirSync(vault)
    const note = createVaultNote(vault, 'Status')
    note.doc = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'base' }] }],
    }
    saveNote(vault, note)
    await initGit(vault)
    await gitCommit(vault, 'Add status note')

    note.doc = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'edited locally' }] }],
    }
    saveNote(vault, note)
    const status = await gitStatus(vault)
    expect(status.repo).toBe(true)
    expect(status.porcelain).toContain('status.stride.json')
    const diff = await gitDiff(vault, 'status.stride.json')
    expect(diff).toContain('edited locally')
    const history = await gitHistory(vault, 'status.stride.json')
    expect(history.some((commit) => commit.subject === 'Add status note')).toBe(true)
    await gitCommit(vault, 'Edit status note')

    const bare = path.join(root, 'origin.git')
    await gitInitBare(bare)
    await gitAddRemote(vault, bare)
    await gitPush(vault)

    const other = path.join(root, 'other')
    await gitClone(bare, other)
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
    await gitCommit(other, 'Other side')
    await gitCommit(vault, 'Vault side')
    await gitPush(vault)

    const pulled = await gitPull(other)
    expect(pulled.conflict).toBe(true)
    expect(pulled.files).toContain(rel)

    await gitResolve(other, rel, 'ours')
    const resolved = fs.readFileSync(oursFile, 'utf8')
    expect(resolved).toContain('SIDE_B')
    expect(resolved).not.toContain('SIDE_A')
    expect(resolved).not.toContain('<<<<<<<')
  })
})
