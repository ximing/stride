import { Calendar, ChevronLeft, ChevronRight } from 'lucide-react'
import { useState, type KeyboardEvent } from 'react'
import { Button, IconButton } from './button'
import { Mark } from './icon'
import { Popover, PopoverContent, PopoverTrigger } from './popover'

export type DatePickerProps = {
  /** Stored value, `YYYY-MM-DD` or ''. */
  value: string
  onChange: (next: string) => void
  ariaLabel: string
  placeholder: string
  prevMonthLabel: string
  nextMonthLabel: string
  /** Footer shortcuts; omit either to hide it. */
  todayLabel?: string
  clearLabel?: string
  /** BCP-47 tag for month/weekday names; defaults to `<html lang>`. */
  locale?: string
  /** 0 = Sunday, 1 = Monday; defaults from the locale (zh → Monday). */
  weekStartsOn?: 0 | 1
  'data-testid'?: string
}

type Day = { key: string; year: number; month: number; day: number }

const DAY_KEY = /^(\d{4})-(\d{2})-(\d{2})$/

function parseDay(value: string): Day | null {
  const match = DAY_KEY.exec(value)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2]) - 1
  const day = Number(match[3])
  const date = new Date(year, month, day)
  if (date.getFullYear() !== year || date.getMonth() !== month || date.getDate() !== day) return null
  return { key: value, year, month, day }
}

function dayKey(year: number, month: number, day: number): string {
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function todayKey(): string {
  const now = new Date()
  return dayKey(now.getFullYear(), now.getMonth(), now.getDate())
}

/** Custom calendar popover: the storage value stays a `YYYY-MM-DD` string,
 * the trigger and grid render locale-aware labels. Pure props — the caller
 * wires persistence and passes translated labels. */
export function DatePicker(props: DatePickerProps) {
  const {
    value,
    onChange,
    ariaLabel,
    placeholder,
    prevMonthLabel,
    nextMonthLabel,
    todayLabel,
    clearLabel,
    'data-testid': testId,
  } = props
  const locale = props.locale ?? (document.documentElement.lang || undefined)
  const weekStartsOn = props.weekStartsOn ?? (locale?.startsWith('zh') ? 1 : 0)

  const selected = parseDay(value)
  const [open, setOpen] = useState(false)
  const [view, setView] = useState(viewOf(selected))

  function viewOf(base: Day | null) {
    const now = new Date()
    return base
      ? { year: base.year, month: base.month }
      : { year: now.getFullYear(), month: now.getMonth() }
  }

  const openPicker = (next: boolean) => {
    setOpen(next)
    if (next) setView(viewOf(parseDay(value)))
  }

  const monthLabel = new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'long' }).format(
    new Date(view.year, view.month, 1),
  )
  // 2023-01-01 was a Sunday: weekday `i` of the visible row order maps onto it.
  const weekdayLabels = Array.from({ length: 7 }, (_, index) =>
    new Intl.DateTimeFormat(locale, { weekday: 'narrow' }).format(
      new Date(2023, 0, 1 + ((weekStartsOn + index) % 7)),
    ),
  )

  const daysInMonth = new Date(view.year, view.month + 1, 0).getDate()
  const leadBlanks = (new Date(view.year, view.month, 1).getDay() - weekStartsOn + 7) % 7
  const cells: (Day | null)[] = [
    ...Array.from({ length: leadBlanks }, () => null),
    ...Array.from({ length: daysInMonth }, (_, index) => ({
      key: dayKey(view.year, view.month, index + 1),
      year: view.year,
      month: view.month,
      day: index + 1,
    })),
  ]

  const shiftMonth = (delta: number) => {
    const next = new Date(view.year, view.month + delta, 1)
    setView({ year: next.getFullYear(), month: next.getMonth() })
  }

  const pick = (day: Day) => {
    onChange(day.key)
    setOpen(false)
  }

  const onGridKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const steps: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }
    const step = steps[event.key]
    if (step === undefined) return
    const current = document.activeElement
    if (!(current instanceof HTMLElement) || !current.dataset.date) return
    event.preventDefault()
    const day = parseDay(current.dataset.date)
    if (!day) return
    const next = new Date(day.year, day.month, day.day + step)
    const key = dayKey(next.getFullYear(), next.getMonth(), next.getDate())
    const inGrid = event.currentTarget.querySelector<HTMLElement>(`[data-date="${key}"]`)
    if (inGrid) {
      inGrid.focus()
    } else {
      setView({ year: next.getFullYear(), month: next.getMonth() })
      requestAnimationFrame(() => {
        document.querySelector<HTMLElement>(`[data-date="${key}"]`)?.focus()
      })
    }
  }

  const display = selected
    ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(
        new Date(selected.year, selected.month, selected.day),
      )
    : ''
  const today = todayKey()

  return (
    <Popover open={open} onOpenChange={openPicker}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="sd-field-input sd-date-trigger"
          data-testid={testId}
          data-empty={display === '' ? 'true' : undefined}
          aria-label={ariaLabel}
        >
          <Mark icon={Calendar} size={14} />
          <span className="sd-date-value">{display || placeholder}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent className="sd-date-popover" collisionPadding={8}>
        <div className="sd-date-head">
          <IconButton
            icon={ChevronLeft}
            iconSize={14}
            label={prevMonthLabel}
            size="sm"
            data-testid={testId ? `${testId}-prev` : undefined}
            onClick={() => shiftMonth(-1)}
          />
          <span className="sd-date-month">{monthLabel}</span>
          <IconButton
            icon={ChevronRight}
            iconSize={14}
            label={nextMonthLabel}
            size="sm"
            data-testid={testId ? `${testId}-next` : undefined}
            onClick={() => shiftMonth(1)}
          />
        </div>
        <div className="sd-date-weekdays" role="row">
          {weekdayLabels.map((label, index) => (
            <span className="sd-date-weekday" key={`${label}-${index}`} aria-hidden>
              {label}
            </span>
          ))}
        </div>
        <div className="sd-date-grid" role="grid" aria-label={monthLabel} onKeyDown={onGridKeyDown}>
          {cells.map((cell, index) =>
            cell ? (
              <button
                key={cell.key}
                type="button"
                role="gridcell"
                className="sd-date-day"
                data-testid={testId ? `${testId}-day` : undefined}
                data-date={cell.key}
                aria-pressed={cell.key === value}
                data-today={cell.key === today ? 'true' : undefined}
                tabIndex={cell.key === (selected?.key ?? today) ? 0 : -1}
                onClick={() => pick(cell)}
              >
                {cell.day}
              </button>
            ) : (
              <span className="sd-date-blank" key={`blank-${index}`} aria-hidden />
            ),
          )}
        </div>
        {todayLabel || clearLabel ? (
          <div className="sd-date-foot">
            {todayLabel ? (
              <Button
                size="sm"
                tone="quiet"
                data-testid={testId ? `${testId}-today` : undefined}
                onClick={() => {
                  onChange(today)
                  setOpen(false)
                }}
              >
                {todayLabel}
              </Button>
            ) : null}
            {clearLabel ? (
              <Button
                size="sm"
                tone="quiet"
                data-testid={testId ? `${testId}-clear` : undefined}
                onClick={() => {
                  onChange('')
                  setOpen(false)
                }}
              >
                {clearLabel}
              </Button>
            ) : null}
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}
