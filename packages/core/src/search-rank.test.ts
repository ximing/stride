import { describe, expect, it } from 'vitest'
import { rankSearch } from './search-rank.ts'

describe('rankSearch', () => {
  it('matches a title substring when BM25 misses the whole word', () => {
    const hits = rankSearch('会议', [{
      id: 'meet',
      title: '会议纪要',
      text: '会议纪要\n正文',
    }], [])
    expect(hits.map((hit) => hit.id)).toEqual(['meet'])
    expect(hits[0]?.source).toBe('title')
    expect(hits[0]?.snippet).toContain('会议')
  })

  it('does not substring-match a body crossing bigram', () => {
    const hits = rankSearch('器学', [{
      id: 'ml',
      title: '笔记',
      text: '笔记\n机器学习',
    }], [])
    expect(hits).toEqual([])
  })

  it('ranks a title hit ahead of a body-only BM25 hit', () => {
    const hits = rankSearch('采购', [
      { id: 'list', title: '采购清单', text: '采购清单\n咖啡' },
      { id: 'body', title: '其他', text: '其他\n采购流程' },
    ], [{ id: 'body', score: 4, snippet: '采购流程' }])
    expect(hits.map((hit) => hit.id)).toEqual(['list', 'body'])
    expect(hits[0]?.source).toBe('title')
    expect(hits[1]?.source).toBe('body')
  })

  it('returns nothing for a blank query', () => {
    expect(rankSearch('  ', [{ id: 'a', title: '会议纪要', text: '会议纪要' }], [])).toEqual([])
  })
})
