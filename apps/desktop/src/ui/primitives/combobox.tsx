import { Check, ChevronDown, Plus } from 'lucide-react'
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Mark } from './icon'
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from './popover'

export type ComboboxOption = {
  value: string
  label?: string
  /** Left dot color as a token reference, e.g. `var(--sd-dot-blue)`. */
  dot?: string
  testId?: string
}

type ComboboxBaseProps = {
  options: readonly ComboboxOption[]
  label?: ReactNode
  placeholder?: string
  searchPlaceholder?: string
  emptyLabel?: ReactNode
  /** Show a trailing "create" row when the query matches no option. */
  allowCreate?: boolean
  createLabel?: (query: string) => string
  disabled?: boolean
  className?: string
  triggerClassName?: string
  inputClassName?: string
  'aria-label'?: string
  'data-testid'?: string
}

export type ComboboxSingleProps = ComboboxBaseProps & {
  multiple?: false
  value: string
  onValueChange: (value: string) => void
}

export type ComboboxMultiProps = ComboboxBaseProps & {
  multiple: true
  values: readonly string[]
  onPick: (value: string) => void
  /** Backspace on an empty input, used to remove the last picked value. */
  onRemoveLast?: () => void
}

export type ComboboxProps = ComboboxSingleProps | ComboboxMultiProps

type Row = { kind: 'option'; option: ComboboxOption } | { kind: 'create'; value: string }

/**
 * Searchable select built on the Popover primitive. Single mode renders a
 * button trigger with the search input inside the popover; multiple mode is a
 * picker whose inline input (the popover anchor) stays visible so callers can
 * wrap it in chips. Options are pure props — no service coupling.
 */
export function Combobox(props: ComboboxProps) {
  const {
    options,
    label,
    placeholder,
    searchPlaceholder,
    emptyLabel,
    allowCreate = false,
    createLabel,
    disabled,
    className,
    triggerClassName,
    inputClassName,
  } = props
  const multi = props.multiple === true ? props : undefined
  const single = props.multiple === true ? undefined : props
  const testId = props['data-testid']
  const ariaLabel = props['aria-label']

  const listId = useId()
  const triggerId = useId()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const searchRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)

  // Single mode keeps the current value selectable even when the caller's
  // option list does not include it yet.
  const value = single?.value ?? ''
  const allOptions: readonly ComboboxOption[] =
    single && value !== '' && !options.some((option) => option.value === value)
      ? [{ value }, ...options]
      : options

  const trimmed = query.trim()
  const lowered = trimmed.toLowerCase()
  const picked = multi ? new Set(multi.values.map((item) => item.toLowerCase())) : null

  const filtered = allOptions.filter((option) => {
    if (picked?.has(option.value.toLowerCase())) return false
    if (lowered === '') return true
    return (
      (option.label ?? option.value).toLowerCase().includes(lowered) ||
      option.value.toLowerCase().includes(lowered)
    )
  })

  const exact =
    lowered !== '' &&
    (allOptions.some(
      (option) =>
        option.value.toLowerCase() === lowered || (option.label ?? '').toLowerCase() === lowered,
    ) ||
      (picked?.has(lowered) ?? false))
  const creatable = allowCreate && trimmed !== '' && !exact

  const rows: Row[] = [
    ...filtered.map((option) => ({ kind: 'option' as const, option })),
    ...(creatable ? [{ kind: 'create' as const, value: trimmed }] : []),
  ]
  const activeIndex = rows.length === 0 ? -1 : Math.min(active, rows.length - 1)

  useEffect(() => {
    if (activeIndex < 0) return
    const item = listRef.current?.children[activeIndex]
    if (item instanceof HTMLElement) item.scrollIntoView?.({ block: 'nearest' })
  }, [activeIndex])

  const pickRow = (row: Row) => {
    const next = row.kind === 'create' ? row.value : row.option.value
    if (multi) {
      multi.onPick(next)
      setQuery('')
      setActive(0)
      searchRef.current?.focus()
    } else if (single) {
      single.onValueChange(next)
      setOpen(false)
      setQuery('')
      setActive(0)
    }
  }

  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      if (!open) setOpen(true)
      setActive((index) => Math.min(index + 1, rows.length - 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActive((index) => Math.max(index - 1, 0))
    } else if (event.key === 'Enter' || (multi && event.key === ',' && trimmed !== '')) {
      event.preventDefault()
      const row = rows[activeIndex]
      if (row) pickRow(row)
    } else if (event.key === 'Escape') {
      if (open) {
        event.preventDefault()
        event.stopPropagation()
        setOpen(false)
      }
    } else if (event.key === 'Tab') {
      setOpen(false)
    } else if (event.key === 'Backspace' && multi && query === '') {
      multi.onRemoveLast?.()
    }
  }

  const onSearchChange = (next: string) => {
    setQuery(next)
    setActive(0)
    if (!open) setOpen(true)
  }

  const handleOpenChange = (next: boolean) => {
    setOpen(next)
    setQuery('')
    if (next && single) {
      const index = allOptions.findIndex((option) => option.value === single.value)
      setActive(Math.max(0, index))
    } else {
      setActive(0)
    }
  }

  const searchInput = (extraClassName?: string) => (
    <input
      ref={searchRef}
      className={extraClassName ?? 'sd-combobox-search'}
      role="combobox"
      aria-expanded={open}
      aria-controls={listId}
      aria-activedescendant={activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined}
      aria-autocomplete="list"
      aria-label={extraClassName ? ariaLabel : undefined}
      data-testid={extraClassName ? testId : undefined}
      value={query}
      placeholder={extraClassName ? placeholder : searchPlaceholder}
      spellCheck={false}
      autoComplete="off"
      onFocus={extraClassName ? () => setOpen(true) : undefined}
      onBlur={
        extraClassName && multi
          ? () => {
              // Options preventDefault their pointerdown, so blur only fires
              // when focus truly leaves — commit a free-typed value then.
              if (allowCreate && trimmed !== '') multi.onPick(trimmed)
              setQuery('')
              setOpen(false)
            }
          : undefined
      }
      onChange={(event) => onSearchChange(event.target.value)}
      onKeyDown={onSearchKeyDown}
    />
  )

  const listBox = (
    <ul
      ref={listRef}
      className="sd-combobox-list"
      role="listbox"
      id={listId}
      aria-multiselectable={multi ? true : undefined}
    >
      {rows.map((row, index) => {
        const activeRow = index === activeIndex
        if (row.kind === 'create') {
          return (
            <li
              key="$create"
              id={`${listId}-${index}`}
              role="option"
              aria-selected={false}
              className={['sd-combobox-option', 'sd-combobox-create', activeRow && 'is-active']
                .filter(Boolean)
                .join(' ')}
              data-testid={testId ? `${testId}-create` : undefined}
              onPointerDown={(event) => event.preventDefault()}
              onMouseEnter={() => setActive(index)}
              onClick={() => pickRow(row)}
            >
              <span className="sd-combobox-create-icon">
                <Mark icon={Plus} size={12} />
              </span>
              <span className="sd-combobox-option-label">
                {createLabel ? createLabel(row.value) : row.value}
              </span>
            </li>
          )
        }
        const selected = single ? row.option.value === single.value : false
        return (
          <li
            key={row.option.value}
            id={`${listId}-${index}`}
            role="option"
            aria-selected={selected}
            className={['sd-combobox-option', activeRow && 'is-active'].filter(Boolean).join(' ')}
            data-testid={row.option.testId}
            onPointerDown={(event) => event.preventDefault()}
            onMouseEnter={() => setActive(index)}
            onClick={() => pickRow(row)}
          >
            {row.option.dot ? (
              <span className="sd-combobox-dot" style={{ background: row.option.dot }} />
            ) : null}
            <span className="sd-combobox-option-label">{row.option.label ?? row.option.value}</span>
            {selected ? (
              <span className="sd-combobox-check">
                <Mark icon={Check} size={14} />
              </span>
            ) : null}
          </li>
        )
      })}
      {rows.length === 0 ? <li className="sd-combobox-empty">{emptyLabel}</li> : null}
    </ul>
  )

  const selectedOption = single
    ? allOptions.find((option) => option.value === single.value)
    : undefined

  return (
    <div className={['sd-field', 'sd-combobox-field', className].filter(Boolean).join(' ')}>
      {label ? (
        <label className="sd-field-label" htmlFor={multi ? undefined : triggerId}>
          {label}
        </label>
      ) : null}
      <Popover open={open} onOpenChange={handleOpenChange}>
        {multi ? (
          <PopoverAnchor asChild>{searchInput(inputClassName ?? 'sd-combobox-input')}</PopoverAnchor>
        ) : (
          <PopoverTrigger asChild>
            <button
              type="button"
              id={triggerId}
              className={['sd-combobox-trigger', triggerClassName].filter(Boolean).join(' ')}
              data-testid={testId}
              aria-label={ariaLabel}
              disabled={disabled}
            >
              {selectedOption?.dot ? (
                <span className="sd-combobox-dot" style={{ background: selectedOption.dot }} />
              ) : null}
              <span
                className={['sd-combobox-value', !selectedOption && 'is-placeholder']
                  .filter(Boolean)
                  .join(' ')}
              >
                {selectedOption?.label ?? selectedOption?.value ?? placeholder ?? ''}
              </span>
              <span className="sd-combobox-chevron">
                <Mark icon={ChevronDown} size={14} />
              </span>
            </button>
          </PopoverTrigger>
        )}
        <PopoverContent
          className="sd-combobox-content"
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            if (!multi) searchRef.current?.focus()
          }}
          onCloseAutoFocus={multi ? (event) => event.preventDefault() : undefined}
        >
          {multi ? listBox : (
            <>
              {searchInput()}
              {listBox}
            </>
          )}
        </PopoverContent>
      </Popover>
    </div>
  )
}
