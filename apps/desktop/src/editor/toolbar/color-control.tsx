import type { LucideIcon } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export function EditorIcon({ icon: Glyph }: { icon: LucideIcon }) {
  return <Glyph aria-hidden="true" size={16} strokeWidth={1.75} />
}

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/

export function ColorControl({
  testId,
  label,
  clearLabel,
  icon,
  value,
  fallback,
  colors,
  open,
  pressed,
  onOpenChange,
  onPick,
}: {
  testId: string
  label: string
  clearLabel: string
  icon: LucideIcon
  value: string
  fallback: string
  colors: readonly { label: string; value: string }[]
  open: boolean
  pressed?: boolean
  onOpenChange: (open: boolean) => void
  onPick: (value: string | null) => void
}) {
  const buttonRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const shown = HEX_COLOR.test(value) ? value : fallback

  useLayoutEffect(() => {
    if (!open) {
      setPos(null)
      return
    }
    const place = () => {
      const anchor = buttonRef.current
      const pop = popRef.current
      if (!anchor || !pop) return
      const rect = anchor.getBoundingClientRect()
      const width = pop.offsetWidth
      const height = pop.offsetHeight
      let left = rect.left
      let top = rect.bottom + 6
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

  useEffect(() => {
    if (!open) return
    const onPointer = (event: MouseEvent) => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (popRef.current?.contains(target) || buttonRef.current?.contains(target)) return
      onOpenChange(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      onOpenChange(false)
    }
    document.addEventListener('mousedown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [onOpenChange, open])

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={`editor-tool editor-color-tool${open || pressed ? ' is-active' : ''}`}
        data-testid={testId}
        aria-label={label}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-pressed={pressed || undefined}
        onMouseDown={(event) => {
          event.preventDefault()
          onOpenChange(!open)
        }}
      >
        <EditorIcon icon={icon} />
        <span className={value ? 'editor-color-bar' : 'editor-color-bar is-empty'} style={value ? { background: value } : undefined} />
      </button>
      {open
        ? createPortal(
            <div
              ref={popRef}
              className="editor-color-pop"
              role="dialog"
              aria-label={label}
              style={{ top: pos?.top ?? 0, left: pos?.left ?? 0, visibility: pos ? 'visible' : 'hidden' }}
              onMouseDown={(event) => {
                if (event.target instanceof HTMLInputElement) return
                event.preventDefault()
              }}
            >
              <div className="editor-color-swatches">
                {colors.map((color) => (
                  <button
                    key={color.value}
                    type="button"
                    className={`editor-color-swatch${value.toLowerCase() === color.value ? ' is-on' : ''}`}
                    style={{ background: color.value }}
                    aria-label={color.label}
                    aria-pressed={value.toLowerCase() === color.value}
                    onClick={() => {
                      onPick(color.value)
                      onOpenChange(false)
                    }}
                  />
                ))}
              </div>
              <label className="editor-color-custom">
                自定义
                <input
                  type="color"
                  aria-label={`${label}自定义`}
                  value={shown}
                  onChange={(event) => onPick(event.target.value)}
                />
              </label>
              <button
                type="button"
                className={value ? 'editor-color-clear' : 'editor-color-clear is-on'}
                onClick={() => {
                  onPick(null)
                  onOpenChange(false)
                }}
              >
                {clearLabel}
              </button>
            </div>,
            document.body,
          )
        : null}
    </>
  )
}
