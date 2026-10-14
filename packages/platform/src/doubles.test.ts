import { describe, expect, it } from 'vitest'
import {
  MemorySearchBackend,
  MemorySecretsStore,
  memorySearchOpener,
  unavailableGit,
  unsupportedUpdater,
} from './index.ts'

describe('unavailableGit', () => {
  it('rejects every method with git-unavailable', async () => {
    const git = unavailableGit()
    expect(git.available).toBe(false)
    const calls = [
      git.init('repo'),
      git.status('repo'),
      git.diff('repo'),
      git.diff('repo', 'note.md'),
      git.commit('repo', 'message'),
      git.commit('repo', 'message', ['note.md']),
      git.history('repo'),
      git.history('repo', 'note.md'),
      git.show('repo', 'abc', 'note.md'),
      git.currentBranch('repo'),
      git.aheadBehind('repo'),
      git.remoteUrl('repo'),
      git.remoteUrl('repo', 'origin'),
      git.addRemote('repo', 'https://example.test/vault.git'),
      git.addRemote('repo', 'https://example.test/vault.git', 'origin'),
      git.fetch('repo'),
      git.fetch('repo', 'origin'),
      git.sharesHistory('repo'),
      git.removeRemote('repo'),
      git.removeRemote('repo', 'origin'),
      git.push('repo'),
      git.pull('repo'),
      git.unmerged('repo'),
      git.resolve('repo', 'note.md', 'ours'),
      git.resolve('repo', 'note.md', 'theirs'),
      git.clone('https://example.test/vault.git', 'dest'),
    ]
    for (const call of calls) {
      await expect(call).rejects.toMatchObject({ name: 'PlatformError', code: 'git-unavailable' })
    }
  })
})

describe('MemorySearchBackend', () => {
  it('upserts, ranks text, limits topK, and returns a snippet', async () => {
    const search = new MemorySearchBackend()
    await search.upsert([
      { id: 'both', text: 'alpha beta extra words', vector: [1, 0] },
      { id: 'one', text: 'alpha only' },
      { id: 'none', text: 'zzz' },
    ])
    await search.upsert([
      { id: 'both', text: 'first' },
      { id: 'both', text: 'alpha beta extra words' },
    ])

    const top = await search.search({ text: 'alpha beta', topK: 1, mode: 'text' })
    expect(top).toHaveLength(1)
    expect(top[0]?.id).toBe('both')
    expect(top[0]?.snippet).toBeTruthy()
    expect('alpha beta extra words').toContain(top[0]?.snippet)

    const ranked = await search.search({
      text: 'Alpha Beta',
      topK: 10,
      mode: 'hybrid',
      vector: [0.2, 0.4, 0.9],
    })
    expect(ranked.map((hit) => hit.id)).toEqual(['both', 'one'])
    expect(ranked[0]?.score).toBeGreaterThan(ranked[1]?.score ?? 0)
    expect(ranked.every((hit) => hit.snippet && rankedText(hit.id).includes(hit.snippet))).toBe(true)

    expect(await search.search({ text: '', topK: 5, mode: 'text' })).toEqual([])
    expect(await search.search({ text: '   ', topK: 5, mode: 'hybrid', vector: [1] })).toEqual([])

    await search.remove(['both', 'missing'])
    expect((await search.search({ text: 'alpha', topK: 10, mode: 'text' })).map((hit) => hit.id)).toEqual(['one'])
  })

  it('rejects calls after close, and the opener ignores dim', async () => {
    const search = new MemorySearchBackend()
    await search.upsert([{ id: 'a', text: 'hello' }])
    await search.close()
    await expect(search.upsert([{ id: 'b', text: 'nope' }])).rejects.toMatchObject({ code: 'io' })
    await expect(search.remove(['a'])).rejects.toMatchObject({ code: 'io' })
    await expect(search.search({ text: 'hello', topK: 1, mode: 'text' })).rejects.toMatchObject({ code: 'io' })
    await expect(search.close()).rejects.toMatchObject({ code: 'io' })

    const opened = await memorySearchOpener().open({ vaultKey: 'vault', dim: 1536 })
    await opened.upsert([{ id: 'n1', text: 'Stride notes' }])
    const hits = await opened.search({ text: 'stride', topK: 3, mode: 'hybrid', vector: [0.2, 0.1] })
    expect(hits[0]?.id).toBe('n1')
    expect('Stride notes').toContain(hits[0]?.snippet)
  })
})

describe('MemorySecretsStore', () => {
  it('round-trips secrets, keeps empty plaintext empty, and isolates instances', async () => {
    const a = new MemorySecretsStore()
    const b = new MemorySecretsStore()
    const sealed = await a.seal('s3cret')
    const again = await a.seal('s3cret')
    expect(sealed).not.toBe('')
    expect(sealed).not.toBe('s3cret')
    expect(again).not.toBe(sealed)
    expect(await a.open(sealed)).toBe('s3cret')
    expect(await a.open(again)).toBe('s3cret')
    expect(await a.open(await a.seal('密钥 🔑'))).toBe('密钥 🔑')
    expect(await a.seal('')).toBe('')
    expect(await a.open('')).toBe('')
    expect(await b.open('')).toBe('')
    await expect(b.open(sealed)).rejects.toMatchObject({ name: 'PlatformError', code: 'io' })
  })
})

describe('unsupportedUpdater', () => {
  it('reports no support, an empty check, and rejected install steps', async () => {
    const updater = unsupportedUpdater()
    expect(updater.supported).toBe(false)
    await expect(updater.check()).resolves.toBeNull()
    await expect(updater.download(() => {})).rejects.toMatchObject({ code: 'unsupported' })
    await expect(updater.installAndRestart()).rejects.toMatchObject({ code: 'unsupported' })
  })
})

function rankedText(id: string): string {
  if (id === 'both') return 'alpha beta extra words'
  if (id === 'one') return 'alpha only'
  return ''
}
