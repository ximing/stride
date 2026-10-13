import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { recoverRename } from '@stride/core'
import { afterEach, describe, expect, it } from 'vitest'
import { NodeFileSystem } from './fs.ts'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('rename crash recovery', () => {
  it('finishes a journal after the child exits 137', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'stride-rename-'))
    dirs.push(dir)
    const childPath = fileURLToPath(new URL('./rename-tx.kill-child.ts', import.meta.url))
    const child = spawn(process.execPath, ['--experimental-strip-types', childPath], {
      env: { ...process.env, STRIDE_RENAME_DIR: dir, STRIDE_RENAME_CRASH: '1' },
    })
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    const status = await new Promise<number | null>((resolve, reject) => {
      child.on('error', reject)
      child.on('exit', (code) => resolve(code))
    })
    expect(status, stderr).toBe(137)

    const fs = new NodeFileSystem(dir)
    await recoverRename(fs)
    const a = await fs.readText('a.stride.json')
    const b = await fs.readText('b.stride.json')
    expect(a).toContain('[[New Title]]')
    expect(b).toContain('[[New Title]]')
    expect(a).not.toContain('[[Old Title]]')
    expect(b).not.toContain('[[Old Title]]')
    expect(await fs.stat('a.stride.json.rename-tmp')).toBeNull()
    expect(await fs.stat('b.stride.json.rename-tmp')).toBeNull()
    expect(await fs.stat('.stride/rename-tx/journal.json')).toBeNull()

    await recoverRename(fs)
    expect(await fs.readText('a.stride.json')).toContain('[[New Title]]')
    expect(await fs.readText('b.stride.json')).toContain('[[New Title]]')
    expect(await fs.readText('a.stride.json')).not.toContain('[[Old Title]]')
    expect(await fs.readText('b.stride.json')).not.toContain('[[Old Title]]')
  })
})
