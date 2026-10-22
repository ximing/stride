import type { FileSystemBackend } from '@stride/platform'

export interface ModelTokenUsage {
  model: string
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  total: number
  requests: number
}

export interface TokenUsageLedger {
  models: ModelTokenUsage[]
}

export interface TokenUsageSample {
  model: string
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  total: number
  /** Defaults to 1. Legacy rows pass the stored call count. */
  requests?: number
}

/** Daily rows live in the vault, outside the note scan. */
export const TOKEN_USAGE_VAULT_FILE = '.stride/token-usage.json'

export interface TokenUsageDay {
  date: string
  model: string
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  total: number
  requests: number
}

export interface TokenUsageHistory {
  days: TokenUsageDay[]
}

export interface TokenUsagePeriod {
  period: string
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  total: number
  requests: number
}

export function emptyTokenUsage(): TokenUsageLedger {
  return { models: [] }
}

function whole(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0
  return value
}

function sampleRow(sample: TokenUsageSample): ModelTokenUsage | null {
  const model = sample.model.trim()
  if (!model) return null
  const input = whole(sample.input)
  const output = whole(sample.output)
  const cacheRead = whole(sample.cacheRead)
  const cacheWrite = whole(sample.cacheWrite)
  const total = Math.max(whole(sample.total), input + output + cacheRead + cacheWrite)
  if (total === 0) return null
  return { model, input, output, cacheRead, cacheWrite, total, requests: 1 }
}

function mergeRow(ledger: TokenUsageLedger, row: ModelTokenUsage): TokenUsageLedger {
  const existing = ledger.models.find((item) => item.model === row.model)
  if (!existing) return { models: [...ledger.models, row] }
  return {
    models: ledger.models.map((item) => item.model === row.model ? {
      model: item.model,
      input: item.input + row.input,
      output: item.output + row.output,
      cacheRead: item.cacheRead + row.cacheRead,
      cacheWrite: item.cacheWrite + row.cacheWrite,
      total: item.total + row.total,
      requests: item.requests + row.requests,
    } : item),
  }
}

/** Add one model call. A blank model or an all-zero sample leaves the ledger unchanged. */
export function addTokenUsage(ledger: TokenUsageLedger, sample: TokenUsageSample): TokenUsageLedger {
  const row = sampleRow(sample)
  if (!row) return ledger
  return mergeRow(ledger, row)
}

export function tokenUsageByTotal(ledger: TokenUsageLedger): ModelTokenUsage[] {
  return [...ledger.models].sort((left, right) => right.total - left.total || left.model.localeCompare(right.model))
}

export function parseTokenUsage(raw: string | null | undefined): TokenUsageLedger {
  if (!raw) return emptyTokenUsage()
  try {
    const parsed = JSON.parse(raw) as { models?: unknown }
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.models)) return emptyTokenUsage()
    return parsed.models.reduce<TokenUsageLedger>((ledger, item) => {
      if (!item || typeof item !== 'object') return ledger
      const row = item as Record<string, unknown>
      if (typeof row.model !== 'string' || !row.model.trim()) return ledger
      const input = whole(row.input)
      const output = whole(row.output)
      const cacheRead = whole(row.cacheRead)
      const cacheWrite = whole(row.cacheWrite)
      const total = Math.max(whole(row.total), input + output + cacheRead + cacheWrite)
      const requests = whole(row.requests) || (total > 0 ? 1 : 0)
      if (total === 0 || requests === 0) return ledger
      return mergeRow(ledger, {
        model: row.model.trim(),
        input,
        output,
        cacheRead,
        cacheWrite,
        total,
        requests,
      })
    }, emptyTokenUsage())
  } catch {
    return emptyTokenUsage()
  }
}

export function serializeTokenUsage(ledger: TokenUsageLedger): string {
  const models = [...ledger.models].sort((left, right) => left.model.localeCompare(right.model))
  return JSON.stringify({ models })
}

export function emptyTokenHistory(): TokenUsageHistory {
  return { days: [] }
}

/** Local calendar day. Week and month views group this civil date. */
export function localDateKey(now = new Date()): string {
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function tokenUsageMonth(date: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date.slice(0, 7) : ''
}

/** ISO week of a civil date, such as `2021-W01`. Invalid dates return ''. */
export function tokenUsageWeek(date: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!match) return ''
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const utc = new Date(Date.UTC(year, month - 1, day))
  if (utc.getUTCFullYear() !== year || utc.getUTCMonth() !== month - 1 || utc.getUTCDate() !== day) return ''
  const weekday = utc.getUTCDay() || 7
  utc.setUTCDate(utc.getUTCDate() + 4 - weekday)
  const weekYear = utc.getUTCFullYear()
  const yearStart = new Date(Date.UTC(weekYear, 0, 1))
  const week = Math.ceil(((utc.getTime() - yearStart.getTime()) / 86400000 + 1) / 7)
  return `${weekYear}-W${String(week).padStart(2, '0')}`
}

function dayFromSample(sample: TokenUsageSample, date: string): TokenUsageDay | null {
  if (!tokenUsageWeek(date)) return null
  const row = sampleRow(sample)
  if (!row) return null
  return { ...row, date, requests: whole(sample.requests) || 1 }
}

/** Add one call to a civil day. A blank model, bad date, or all-zero sample returns the same history. */
export function addTokenUsageDay(history: TokenUsageHistory, sample: TokenUsageSample, date: string): TokenUsageHistory {
  const row = dayFromSample(sample, date)
  if (!row) return history
  const index = history.days.findIndex((item) => item.date === row.date && item.model === row.model)
  if (index === -1) return { days: [...history.days, row] }
  const existing = history.days[index]!
  const days = history.days.slice()
  days[index] = {
    date: existing.date,
    model: existing.model,
    input: existing.input + row.input,
    output: existing.output + row.output,
    cacheRead: existing.cacheRead + row.cacheRead,
    cacheWrite: existing.cacheWrite + row.cacheWrite,
    total: existing.total + row.total,
    requests: existing.requests + row.requests,
  }
  return { days }
}

function sumDays(days: TokenUsageDay[], keyOf: (date: string) => string): TokenUsagePeriod[] {
  const grouped = new Map<string, TokenUsagePeriod>()
  for (const day of days) {
    const period = keyOf(day.date)
    if (!period) continue
    const current = grouped.get(period)
    grouped.set(period, {
      period,
      input: (current?.input ?? 0) + day.input,
      output: (current?.output ?? 0) + day.output,
      cacheRead: (current?.cacheRead ?? 0) + day.cacheRead,
      cacheWrite: (current?.cacheWrite ?? 0) + day.cacheWrite,
      total: (current?.total ?? 0) + day.total,
      requests: (current?.requests ?? 0) + day.requests,
    })
  }
  return [...grouped.values()].sort((left, right) => left.period.localeCompare(right.period))
}

export function tokenUsageByModel(history: TokenUsageHistory): ModelTokenUsage[] {
  const ledger = history.days.reduce((current, day) => mergeRow(current, {
    model: day.model,
    input: day.input,
    output: day.output,
    cacheRead: day.cacheRead,
    cacheWrite: day.cacheWrite,
    total: day.total,
    requests: day.requests,
  }), emptyTokenUsage())
  return tokenUsageByTotal(ledger)
}

export function tokenUsageByWeek(history: TokenUsageHistory): TokenUsagePeriod[] {
  return sumDays(history.days, tokenUsageWeek)
}

export function tokenUsageByMonth(history: TokenUsageHistory): TokenUsagePeriod[] {
  return sumDays(history.days, tokenUsageMonth)
}

export function tokenUsageModelsInPeriod(
  history: TokenUsageHistory,
  grain: 'week' | 'month',
  period: string,
): ModelTokenUsage[] {
  const keyOf = grain === 'week' ? tokenUsageWeek : tokenUsageMonth
  return tokenUsageByModel({ days: history.days.filter((day) => keyOf(day.date) === period) })
}

function dayFromUnknown(row: Record<string, unknown>, date: string): TokenUsageDay | null {
  if (typeof row.model !== 'string') return null
  return dayFromSample({
    model: row.model,
    input: whole(row.input),
    output: whole(row.output),
    cacheRead: whole(row.cacheRead),
    cacheWrite: whole(row.cacheWrite),
    total: whole(row.total),
    requests: whole(row.requests) || undefined,
  }, date)
}

export function parseTokenUsageHistory(raw: string | null | undefined): TokenUsageHistory {
  if (!raw) return emptyTokenHistory()
  try {
    const parsed = JSON.parse(raw) as { days?: unknown; models?: unknown }
    if (!parsed || typeof parsed !== 'object') return emptyTokenHistory()
    const rows = Array.isArray(parsed.days) ? parsed.days : []
    let history = rows.reduce<TokenUsageHistory>((current, item) => {
      if (!item || typeof item !== 'object') return current
      const row = item as Record<string, unknown>
      const date = typeof row.date === 'string' ? row.date : ''
      const day = dayFromUnknown(row, date)
      if (!day) return current
      return addTokenUsageDay(current, day, day.date)
    }, emptyTokenHistory())
    if (history.days.length > 0 || !Array.isArray(parsed.models)) return history
    return parsed.models.reduce<TokenUsageHistory>((current, item) => {
      if (!item || typeof item !== 'object') return current
      const row = item as Record<string, unknown>
      if (typeof row.model !== 'string' || !row.model.trim()) return current
      const input = whole(row.input)
      const output = whole(row.output)
      const cacheRead = whole(row.cacheRead)
      const cacheWrite = whole(row.cacheWrite)
      const total = Math.max(whole(row.total), input + output + cacheRead + cacheWrite)
      if (total === 0) return current
      return {
        days: [...current.days, {
          date: '',
          model: row.model.trim(),
          input,
          output,
          cacheRead,
          cacheWrite,
          total,
          requests: whole(row.requests) || 1,
        }],
      }
    }, emptyTokenHistory())
  } catch {
    return emptyTokenHistory()
  }
}

export function serializeTokenUsageHistory(history: TokenUsageHistory): string {
  const days = [...history.days].sort((left, right) => left.date.localeCompare(right.date) || left.model.localeCompare(right.model))
  return `${JSON.stringify({ days }, null, 2)}\n`
}

export async function readTokenUsageHistory(fs: FileSystemBackend): Promise<TokenUsageHistory> {
  const stat = await fs.stat(TOKEN_USAGE_VAULT_FILE)
  if (!stat || stat.kind !== 'file') return emptyTokenHistory()
  try {
    return parseTokenUsageHistory(await fs.readText(TOKEN_USAGE_VAULT_FILE))
  } catch {
    return emptyTokenHistory()
  }
}

export async function writeTokenUsageHistory(fs: FileSystemBackend, history: TokenUsageHistory): Promise<void> {
  await fs.writeText(TOKEN_USAGE_VAULT_FILE, serializeTokenUsageHistory(history))
}
