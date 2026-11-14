// @vitest-environment node
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { detectAgentExecutables } from './agent-which.ts'

async function executable(file: string) {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, '#!/bin/sh\nexit 0\n')
  await chmod(file, 0o755)
}

describe('detectAgentExecutables', () => {
  let home = ''

  afterEach(async () => {
    if (home) await rm(home, { recursive: true, force: true })
    home = ''
  })

  it('prefers PATH, then the highest version bin, and keeps the shim path', async () => {
    home = await mkdtemp(join(tmpdir(), 'stride-which-'))
    const pathGrok = join(home, 'path', 'grok')
    const pathClaude = join(home, 'path', 'claude')
    const decoy = join(home, 'decoy')
    await executable(pathGrok)
    await executable(pathClaude)
    await mkdir(join(decoy, 'codex'), { recursive: true })
    const versionGrok = join(home, '.local/share/fnm/node-versions/v26.7.0/installation/bin/grok')
    await executable(versionGrok)
    const codexJs = join(home, '.local/share/fnm/node-versions/v26.7.0/installation/lib/codex.js')
    await executable(codexJs)
    const codexShim = join(home, '.local/share/fnm/node-versions/v26.7.0/installation/bin/codex')
    await mkdir(dirname(codexShim), { recursive: true })
    await symlink('../lib/codex.js', codexShim)
    await executable(join(home, '.local/share/fnm/node-versions/v24.14.0/installation/bin/codex'))
    const vendor = join(home, '.local/share/fnm/node-versions/v26.7.0/installation/lib/node_modules/@openai/codex/vendor/bin/codex')
    await executable(vendor)
    await executable(join(home, '.nvm/versions/node/v20.11.0/bin/codex'))

    const found = await detectAgentExecutables({
      home,
      pathEnv: [decoy, join(home, 'path')].join(delimiter),
    })

    expect(found.grok).toBe(pathGrok)
    expect(found.claude).toBe(pathClaude)
    expect(found.codex).toBe(codexShim)
    expect(found.codex).not.toBe(vendor)
  })

  it('uses a macOS fnm root, then volta, when PATH has no hit', async () => {
    home = await mkdtemp(join(tmpdir(), 'stride-which-'))
    const macCodex = join(home, 'Library/Application Support/fnm/node-versions/v22.1.0/installation/bin/codex')
    await executable(macCodex)
    const volta = join(home, '.volta/bin/grok')
    await executable(volta)
    const found = await detectAgentExecutables({ home, pathEnv: '' })
    expect(found.codex).toBe(macCodex)
    expect(found.grok).toBe(volta)
    expect(found.claude).toBeNull()
  })

  it('lets a newer nvm install beat an older fnm install', async () => {
    home = await mkdtemp(join(tmpdir(), 'stride-which-'))
    await executable(join(home, '.local/share/fnm/node-versions/v24.14.0/installation/bin/codex'))
    const nvm = join(home, '.nvm/versions/node/v26.7.0/bin/codex')
    await executable(nvm)
    const found = await detectAgentExecutables({ home })
    expect(found.codex).toBe(nvm)
  })
})
