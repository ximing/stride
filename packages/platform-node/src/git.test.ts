import { execFileSync } from 'node:child_process'
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

function gitRemotes(dir: string): string[] {
  return execFileSync('git', ['remote'], { cwd: dir, encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

function originUrl(dir: string): string {
  return execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: dir, encoding: 'utf8' }).trim()
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
    await gitClone(git, bare, other, os.homedir())
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

  it('rejects an unrelated remote and still accepts a cloned origin', async () => {
    const root = tempDir()
    const left = path.join(root, 'left')
    const right = path.join(root, 'right')
    fs.mkdirSync(left)
    fs.mkdirSync(right)
    fs.writeFileSync(path.join(left, 'left.txt'), 'left\n')
    fs.writeFileSync(path.join(right, 'right.txt'), 'right\n')
    await initGit(at(left), git, os.homedir())
    await initGit(at(right), git, os.homedir())
    await expect(gitAddRemote(at(left), git, right)).rejects.toThrow(
      'Remote history is not compatible with this vault',
    )
    expect(gitRemotes(left)).not.toContain('origin')

    const bare = path.join(root, 'shared.git')
    await gitInitBare(bare)
    await gitAddRemote(at(right), git, bare)
    await gitPush(at(right), git)
    const clone = path.join(root, 'clone')
    await gitClone(git, bare, clone, os.homedir())
    await gitAddRemote(at(clone), git, bare)
    expect(gitRemotes(clone)).toContain('origin')
  })

  it('restores an existing origin when the replacement remote is unrelated', async () => {
    const root = tempDir()
    const vault = path.join(root, 'vault')
    const unrelated = path.join(root, 'unrelated')
    fs.mkdirSync(vault)
    fs.mkdirSync(unrelated)
    fs.writeFileSync(path.join(vault, 'vault.txt'), 'vault\n')
    fs.writeFileSync(path.join(unrelated, 'other.txt'), 'other\n')
    await initGit(at(vault), git, os.homedir())
    await initGit(at(unrelated), git, os.homedir())
    const bare = path.join(root, 'origin.git')
    await gitInitBare(bare)
    await gitAddRemote(at(vault), git, bare)
    await gitPush(at(vault), git)
    const original = originUrl(vault)
    await expect(gitAddRemote(at(vault), git, unrelated)).rejects.toThrow(
      'Remote history is not compatible with this vault',
    )
    expect(originUrl(vault)).toBe(original)
    expect(gitRemotes(vault)).toContain('origin')
  })
})
