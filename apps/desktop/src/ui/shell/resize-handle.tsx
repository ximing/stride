import { observer, useService } from '@rabjs/react'
import { useRef, type KeyboardEvent, type PointerEvent } from 'react'
import { LayoutService } from '../../services/layout/layout.service'
import { COLUMN_LIMITS, type ResizableColumn } from '../../services/layout/layout'

const STEP = 16

interface ResizeHandleProps {
  column: ResizableColumn
  /** 'start' handles sit before their column (dragging right shrinks it). */
  edge?: 'end' | 'start'
  onDoubleToggle?: () => void
  label: string
}

export const ResizeHandle = observer(function ResizeHandle({ column, edge = 'end', onDoubleToggle, label }: ResizeHandleProps) {
  const layout = useService(LayoutService)
  const drag = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null)

  const width = column === 'sidebar' ? layout.sidebarWidth : column === 'noteList' ? layout.noteListWidth : layout.rightPanelWidth

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    event.preventDefault()
    drag.current = { pointerId: event.clientX !== undefined ? event.pointerId : 0, startX: event.clientX, startWidth: width }
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    const active = drag.current
    if (!active) return
    const delta = event.clientX - active.startX
    const next = edge === 'end' ? active.startWidth + delta : active.startWidth - delta
    layout.setColumnWidth(column, next)
  }

  function onPointerUp(event: PointerEvent<HTMLDivElement>) {
    if (!drag.current) return
    drag.current = null
    event.currentTarget.releasePointerCapture?.(event.pointerId)
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const direction = event.key === 'ArrowRight' ? 1 : -1
    const signed = edge === 'end' ? direction : -direction
    layout.setColumnWidth(column, width + signed * STEP)
  }

  return (
    <div
      className="col-resize"
      data-testid={`resize-${column}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      aria-valuemin={COLUMN_LIMITS[column].min}
      aria-valuemax={COLUMN_LIMITS[column].max}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={onDoubleToggle}
      onKeyDown={onKeyDown}
    />
  )
})
