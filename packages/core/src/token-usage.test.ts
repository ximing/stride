import { MemoryFileSystem } from '@stride/platform'
import { describe, expect, it } from 'vitest'
import {
  addTokenUsage,
  addTokenUsageDay,
  emptyTokenHistory,
  emptyTokenUsage,
  parseTokenUsage,
  parseTokenUsageHistory,
  readTokenUsageHistory,
  serializeTokenUsage,
  serializeTokenUsageHistory,
  tokenUsageByModel,
  tokenUsageByMonth,
  tokenUsageByTotal,
  tokenUsageByWeek,
  tokenUsageModelsInPeriod,
  tokenUsageMonth,
  tokenUsageWeek,
  writeTokenUsageHistory,
  TOKEN_USAGE_VAULT_FILE,
} from './token-usage.ts'

describe('token usage ledger', () => {
  it('adds calls onto the same model and keeps other models apart', () => {
    const once = addTokenUsage(emptyTokenUsage(), {
      model: 'gpt-4o-mini',
      input: 3,
      output: 2,
      cacheRead: 1,
      cacheWrite: 0,
      total: 4,
    })
    const twice = addTokenUsage(once, {
      model: ' gpt-4o-mini ',
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 4,
      total: 0,
    })
    const both = addTokenUsage(twice, {
      model: 'deepseek-chat',
      input: 8,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      total: 10,
    })
    expect(both.models).toEqual([
      {
        model: 'gpt-4o-mini',
        input: 4,
        output: 3,
        cacheRead: 1,
        cacheWrite: 4,
        total: 12,
        requests: 2,
      },
      {
        model: 'deepseek-chat',
        input: 8,
        output: 2,
        cacheRead: 0,
        cacheWrite: 0,
        total: 10,
        requests: 1,
      },
    ])
    expect(once.models).toHaveLength(1)
    expect(once.models[0]?.total).toBe(6)
    expect(tokenUsageByTotal(both).map((row) => row.model)).toEqual(['gpt-4o-mini', 'deepseek-chat'])
  })

  it('ignores a blank model and an empty sample', () => {
    const ledger = emptyTokenUsage()
    expect(addTokenUsage(ledger, {
      model: '  ',
      input: 3,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      total: 4,
    })).toBe(ledger)
    expect(addTokenUsage(ledger, {
      model: 'gpt-4o-mini',
      input: 0,
      output: Number.NaN,
      cacheRead: -2,
      cacheWrite: 0,
      total: 0,
    })).toBe(ledger)
  })

  it('round-trips stored rows and drops junk', () => {
    const ledger = addTokenUsage(addTokenUsage(emptyTokenUsage(), {
      model: 'b',
      input: 2,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      total: 4,
    }), {
      model: 'a',
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      total: 2,
    })
    const raw = serializeTokenUsage(ledger)
    expect(JSON.parse(raw).models.map((row: { model: string }) => row.model)).toEqual(['a', 'b'])
    const stored = [...ledger.models].sort((left, right) => left.model.localeCompare(right.model))
    expect(parseTokenUsage(raw).models).toEqual(stored)
    expect(parseTokenUsage('not json')).toEqual(emptyTokenUsage())
    expect(parseTokenUsage(JSON.stringify({ models: [{ model: '' }, { nope: true }, 'x'] }))).toEqual(emptyTokenUsage())
    expect(parseTokenUsage(JSON.stringify({
      models: [{ model: 'kept', input: 2, output: 0, total: 2, requests: 3 }],
    })).models).toEqual([{
      model: 'kept',
      input: 2,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 2,
      requests: 3,
    }])
  })
})

describe('token usage history', () => {
  it('buckets a civil date into an ISO week and a month', () => {
    expect(tokenUsageWeek('2021-01-01')).toBe('2020-W53')
    expect(tokenUsageWeek('2021-01-03')).toBe('2020-W53')
    expect(tokenUsageWeek('2021-01-04')).toBe('2021-W01')
    expect(tokenUsageWeek('2026-02-31')).toBe('')
    expect(tokenUsageMonth('2021-01-04')).toBe('2021-01')
    expect(tokenUsageMonth('nope')).toBe('')
  })

  it('merges calls on the same day and keeps other days apart', () => {
    const history = emptyTokenHistory()
    const once = addTokenUsageDay(history, {
      model: 'gpt-4o-mini',
      input: 3,
      output: 2,
      cacheRead: 1,
      cacheWrite: 0,
      total: 4,
    }, '2021-01-01')
    const twice = addTokenUsageDay(once, {
      model: ' gpt-4o-mini ',
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 4,
      total: 0,
    }, '2021-01-01')
    const later = addTokenUsageDay(twice, {
      model: 'deepseek-chat',
      input: 4,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      total: 5,
    }, '2021-01-04')
    expect(addTokenUsageDay(history, {
      model: ' ',
      input: 3,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      total: 4,
    }, '2021-01-01')).toBe(history)
    expect(addTokenUsageDay(history, {
      model: 'gpt-4o-mini',
      input: 3,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      total: 4,
    }, '2021-02-31')).toBe(history)
    expect(later.days).toEqual([
      {
        date: '2021-01-01',
        model: 'gpt-4o-mini',
        input: 4,
        output: 3,
        cacheRead: 1,
        cacheWrite: 4,
        total: 12,
        requests: 2,
      },
      {
        date: '2021-01-04',
        model: 'deepseek-chat',
        input: 4,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        total: 5,
        requests: 1,
      },
    ])
    expect(tokenUsageByModel(later).map((row) => row.model)).toEqual(['gpt-4o-mini', 'deepseek-chat'])
    expect(tokenUsageByWeek(later)).toEqual([
      { period: '2020-W53', input: 4, output: 3, cacheRead: 1, cacheWrite: 4, total: 12, requests: 2 },
      { period: '2021-W01', input: 4, output: 1, cacheRead: 0, cacheWrite: 0, total: 5, requests: 1 },
    ])
    expect(tokenUsageByMonth(later)).toEqual([
      { period: '2021-01', input: 8, output: 4, cacheRead: 1, cacheWrite: 4, total: 17, requests: 3 },
    ])
    expect(tokenUsageModelsInPeriod(later, 'week', '2021-W01').map((row) => row.model)).toEqual(['deepseek-chat'])
  })

  it('round-trips the vault file and keeps undated legacy rows out of the trend', async () => {
    const fs = new MemoryFileSystem('vault')
    const history = addTokenUsageDay(addTokenUsageDay(emptyTokenHistory(), {
      model: 'b',
      input: 2,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      total: 4,
    }, '2021-01-04'), {
      model: 'a',
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      total: 2,
      requests: 4,
    }, '2020-12-31')
    await writeTokenUsageHistory(fs, history)
    const raw = await fs.readText(TOKEN_USAGE_VAULT_FILE)
    expect(JSON.parse(raw).days.map((row: { model: string }) => row.model)).toEqual(['a', 'b'])
    expect(await readTokenUsageHistory(fs)).toEqual(parseTokenUsageHistory(serializeTokenUsageHistory(history)))
    const legacy = parseTokenUsageHistory(JSON.stringify({
      models: [{ model: 'old', input: 2, output: 0, total: 2, requests: 3 }],
    }))
    expect(tokenUsageByModel(legacy).map((row) => [row.model, row.requests])).toEqual([['old', 3]])
    expect(tokenUsageByWeek(legacy)).toEqual([])
    expect(tokenUsageByMonth(legacy)).toEqual([])
    expect(await readTokenUsageHistory(new MemoryFileSystem('empty'))).toEqual(emptyTokenHistory())
  })
})
