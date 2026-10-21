import { Check, ChevronDown } from 'lucide-react'
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

const MENU_TABBABLE =
  'a[href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), button:not(:disabled)'

function tabbables(root: ParentNode): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(MENU_TABBABLE)).filter((element) => {
    if (element.closest('.select-menu')) return false
    if (element.tabIndex < 0) return false
    return true
  })
}

/** Tab from an open menu moves focus the way a native menu would. */
function focusAfterMenuTab(trigger: HTMLButtonElement, shift: boolean): void {
  const dialog = trigger.closest<HTMLElement>('[role="dialog"], dialog')
  const elements = tabbables(dialog ?? document.body)
  const index = elements.indexOf(trigger)
  if (index < 0) {
    trigger.focus({ preventScroll: true })
    return
  }
  const nextIndex = shift ? index - 1 : index + 1
  if (!dialog) {
    ;(elements[nextIndex] ?? trigger).focus({ preventScroll: true })
    return
  }
  const wrapped =
    nextIndex < 0 ? elements[elements.length - 1] : nextIndex >= elements.length ? elements[0] : elements[nextIndex]
  ;(wrapped ?? trigger).focus({ preventScroll: true })
}

export function ToolSelect({
  testId,
  label,
  value,
  options,
  onChange,
}: {
  testId: string
  label: string
  value: string
  options: readonly { value: string; label: string }[]
  onChange: (value: string) => void
}) {
  const listId = useId()
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([])
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const selectedIndex = options.findIndex((option) => option.value === value)
  const current = selectedIndex >= 0 ? options[selectedIndex] : undefined

  function openAt(index: number) {
    if (options.length === 0) return
    const clamped = Math.min(Math.max(index, 0), options.length - 1)
    setActiveIndex(clamped)
    setOpen(true)
  }

  function choose(next: string) {
    if (next !== value) onChange(next)
    setOpen(false)
    buttonRef.current?.focus({ preventScroll: true })
  }

  useLayoutEffect(() => {
    if (!open) {
      setPos(null)
      return
    }
    const place = () => {
      const anchor = buttonRef.current
      const menu = menuRef.current
      if (!anchor || !menu) return
      const rect = anchor.getBoundingClientRect()
      let left = rect.left
      let top = rect.bottom + 6
      const width = menu.offsetWidth
      const height = menu.offsetHeight
      if (left + width > window.innerWidth - 8) left = Math.max(8, window.innerWidth - width - 8)
      if (top + height > window.innerHeight - 8) top = Math.max(8, rect.top - height - 6)
      setPos((prev) => (prev && prev.top === top && prev.left === left ? prev : { top, left }))
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open])

  useLayoutEffect(() => {
    if (!open) return
    optionRefs.current[activeIndex]?.focus({ preventScroll: true })
  }, [open, activeIndex])

  useEffect(() => {
    if (!open) return
    const onPointer = (event: MouseEvent) => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (menuRef.current?.contains(target) || buttonRef.current?.contains(target)) return
      setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        setOpen(false)
        buttonRef.current?.focus({ preventScroll: true })
        return
      }
      if (event.key !== 'Tab') return
      const trigger = buttonRef.current
      if (!trigger) return
      event.preventDefault()
      event.stopPropagation()
      setOpen(false)
      focusAfterMenuTab(trigger, event.shiftKey)
    }
    window.addEventListener('mousedown', onPointer)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('mousedown', onPointer)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={`editor-tool-select${open ? ' is-open' : ''}`}
        data-testid={testId}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        onMouseDown={(event) => {
          event.preventDefault()
          if (open) setOpen(false)
          else openAt(selectedIndex >= 0 ? selectedIndex : 0)
        }}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
          event.preventDefault()
          openAt(selectedIndex >= 0 ? selectedIndex : event.key === 'ArrowUp' ? options.length - 1 : 0)
        }}
      >
        <span>{current?.label ?? label}</span>
        <ChevronDown aria-hidden="true" size={14} strokeWidth={1.75} />
      </button>
      {open
        ? createPortal(
            <div
              ref={menuRef}
              id={listId}
              className="select-menu editor-select-menu"
              role="listbox"
              aria-label={label}
              style={{ top: pos?.top ?? 0, left: pos?.left ?? 0, visibility: pos ? 'visible' : 'hidden' }}
              onMouseDown={(event) => event.preventDefault()}
            >
              {options.map((option, index) => (
                <button
                  key={option.value || 'default'}
                  ref={(node) => {
                    optionRefs.current[index] = node
                  }}
                  type="button"
                  role="option"
                  data-value={option.value}
                  aria-selected={option.value === value}
                  className={[option.value === value ? 'is-on' : '', index === activeIndex ? 'is-active' : '']
                    .filter(Boolean)
                    .join(' ') || undefined}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => choose(option.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'ArrowDown') {
                      event.preventDefault()
                      setActiveIndex((currentIndex) => (currentIndex + 1) % options.length)
                    } else if (event.key === 'ArrowUp') {
                      event.preventDefault()
                      setActiveIndex((currentIndex) => (currentIndex - 1 + options.length) % options.length)
                    } else if (event.key === 'Home') {
                      event.preventDefault()
                      setActiveIndex(0)
                    } else if (event.key === 'End') {
                      event.preventDefault()
                      setActiveIndex(options.length - 1)
                    }
                  }}
                >
                  <span className="editor-select-option-check" aria-hidden="true">
                    {option.value === value ? <Check size={14} strokeWidth={1.75} /> : null}
                  </span>
                  <span>{option.label}</span>
                </button>
              ))}
            </div>,
            document.body,
          )
        : null}
    </>
  )
}
