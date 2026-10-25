import type { LucideIcon } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { createPortal } from 'react-dom'
import { Tip } from '../../ui/primitives/tooltip'
import { colorLabel, type EditorColor } from '../colors'

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
  clearSwatch,
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
  colors: readonly EditorColor[]
  clearSwatch?: string
  open: boolean
  pressed?: boolean
  onOpenChange: (open: boolean) => void
  onPick: (value: string | null) => void
}) {
  const { t } = useTranslation()
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
      <Tip content={label}>
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
        <span className="editor-color-mark">
          <EditorIcon icon={icon} />
          <span className={value ? 'editor-color-bar' : 'editor-color-bar is-empty'} style={value ? { background: value } : undefined} />
        </span>
      </button>
      </Tip>
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
                {colors.map((color) => {
                  const selected = value.toLowerCase() === color.value
                  return (
                    <Tip key={color.id} content={colorLabel(t, color)}>
                    <button
                      type="button"
                      className={`editor-color-swatch${selected ? ' is-on' : ''}`}
                      style={{ background: color.value }}
                      aria-label={colorLabel(t, color)}
                      aria-pressed={selected}
                      onClick={() => {
                        onPick(color.value)
                        onOpenChange(false)
                      }}
                    />
                    </Tip>
                  )
                })}
              </div>
              <div className="editor-color-actions">
                <button
                  type="button"
                  className={value ? 'editor-color-clear' : 'editor-color-clear is-on'}
                  onClick={() => {
                    onPick(null)
                    onOpenChange(false)
                  }}
                >
                  <span className="editor-color-none" style={clearSwatch ? { background: clearSwatch } : undefined} aria-hidden="true" />
                  {clearLabel}
                </button>
                <label className="editor-color-custom">
                  <span
                    className="editor-color-custom-chip"
                    style={
                      value
                        ? { background: shown }
                        : { background: 'conic-gradient(#d24b4b, #e0a03a, #d6c25a, #4e9a62, #3d78b4, #7a5aa0, #d24b4b)' }
                    }
                    aria-hidden="true"
                  />
                  {t('editor.custom')}
                  <input
                    type="color"
                    aria-label={t('editor.customOf', { label })}
                    value={shown}
                    onChange={(event) => onPick(event.target.value)}
                  />
                </label>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  )
}
