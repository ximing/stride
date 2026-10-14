import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEDICATED_ERROR,
  createVaultNote,
  gitAddRemote,
  gitClone,
  gitCommit,
  gitDiff,
  gitHistory,
  gitPull,
  gitPush,
  gitResolve,
  gitStatus,
  initGit,
  isBroadPersonalRoot,
  isDedicatedVault,
  markDedicatedVault,
  saveNote,
} from '@stride/core'
import { NodeFileSystem, NodeGitBackend, gitInitBare } from './index.ts'

const dirs: string[] = []
const git = new NodeGitBackend()

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stride-git-'))
  dirs.push(dir)
  return dir
}

function at(dir: string): NodeFileSystem {
  return new NodeFileSystem(dir)
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
    await expect(initGit(at(documents), git, os.homedir())).rejects.toThrow(DEDICATED_ERROR)
    expect(fs.existsSync(path.join(documents, '.git'))).toBe(false)

    expect(isBroadPersonalRoot(os.homedir(), os.homedir())).toBe(true)
    if (!(await isDedicatedVault(at(os.homedir())))) {
      await expect(initGit(at(os.homedir()), git, os.homedir())).rejects.toThrow(DEDICATED_ERROR)
    }

    const marked = path.join(root, 'Downloads')
    fs.mkdirSync(marked)
    await markDedicatedVault(at(marked))
    await initGit(at(marked), git, os.homedir())
    expect(fs.existsSync(path.join(marked, '.git'))).toBe(true)

    const vault = path.join(root, 'dedicated-vault')
    fs.mkdirSync(vault)
    await initGit(at(vault), git, os.homedir())
    const note = await createVaultNote(at(vault), 'Status')
    note.doc = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'base' }] }],
    }
    await saveNote(at(vault), note)
    await gitCommit(at(vault), git, 'Add status note')

    note.doc = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'edited locally' }] }],
    }
    await saveNote(at(vault), note)
    const status = await gitStatus(at(vault), git)
    expect(status.repo).toBe(true)
    expect(status.porcelain).toContain('status.stride.json')
    const diff = await gitDiff(at(vault), git, 'status.stride.json')
    expect(diff).toContain('edited locally')
    const history = await gitHistory(at(vault), git, 'status.stride.json')
    expect(history.some((commit) => commit.subject === 'Add status note')).toBe(true)
    await gitCommit(at(vault), git, 'Edit status note')

    const bare = path.join(root, 'origin.git')
    await gitInitBare(bare)
    await gitAddRemote(at(vault), git, bare)
    await gitPush(at(vault), git)

    const other = path.join(root, 'other')
    await gitClone(git, bare, other)
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
    await gitCommit(at(other), git, 'Other side')
    await gitCommit(at(vault), git, 'Vault side')
    await gitPush(at(vault), git)

    const pulled = await gitPull(at(other), git)
    expect(pulled.conflict).toBe(true)
    expect(pulled.files).toContain(rel)

    await gitResolve(at(other), git, rel, 'ours')
    const resolved = fs.readFileSync(oursFile, 'utf8')
    expect(resolved).toContain('SIDE_B')
    expect(resolved).not.toContain('SIDE_A')
    expect(resolved).not.toContain('<<<<<<<')
  })
})
