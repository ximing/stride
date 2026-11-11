import type { Editor } from '@tiptap/core'
import { Check, Copy, EllipsisVertical, Scissors, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Mark } from '../../ui/primitives/icon'
import { Tip } from '../../ui/primitives/tooltip'
import {
  blockHitAt,
  copyBlock,
  cutBlock,
  deleteBlock,
  placeBlockActions,
  type BlockBox,
  type BlockHit,
} from './block-actions'

const HIDE_MS = 80
const COPIED_MS = 1200

function elementAt(x: number, y: number): Element | null {
  if (typeof document.elementFromPoint !== 'function') return null
  return document.elementFromPoint(x, y)
}

export function BlockHandle({ editor }: { editor: Editor }) {
  const { t } = useTranslation()
  const [hit, setHit] = useState<BlockHit | null>(null)
  const [box, setBox] = useState<BlockBox | null>(null)
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const [editable, setEditable] = useState(() => editor.isEditable)
  const hitRef = useRef<BlockHit | null>(null)
  const barRef = useRef<HTMLDivElement>(null)
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pointer = useRef({ x: 0, y: 0 })
  const placeRef = useRef<(dom: HTMLElement) => void>(() => {})
  const api = useRef({ clearHide: () => {}, hide: () => {} })

  placeRef.current = (dom) => {
    if (editor.isDestroyed) return
    const scroll = editor.view.dom.closest('.editor-scroll')
    if (!(scroll instanceof HTMLElement) || !dom.isConnected) {
      setBox(null)
      return
    }
    const block = dom.getBoundingClientRect()
    const frame = scroll.getBoundingClientRect()
    const next = placeBlockActions({
      block: { top: block.top, left: block.left, bottom: block.bottom },
      frame: { top: frame.top, left: frame.left },
      scrollTop: scroll.scrollTop,
      scrollLeft: scroll.scrollLeft,
      clientTop: scroll.clientTop,
      clientLeft: scroll.clientLeft,
      clientHeight: scroll.clientHeight,
    })
    setBox((prev) => (sameBox(prev, next) ? prev : next))
  }

  useEffect(() => {
    if (editor.isDestroyed) return
    const root = editor.view.dom

    const clearHide = () => {
      if (hideTimer.current != null) clearTimeout(hideTimer.current)
      hideTimer.current = null
    }
    const hide = () => {
      clearHide()
      hideTimer.current = setTimeout(() => {
        hideTimer.current = null
        const bar = barRef.current
        const under = elementAt(pointer.current.x, pointer.current.y)
        if (under && bar?.contains(under)) return
        if (under && !editor.isDestroyed && blockHitAt(editor.view, under)) return
        hitRef.current = null
        setHit(null)
        setBox(null)
      }, HIDE_MS)
    }
    api.current = { clearHide, hide }

    const show = (next: BlockHit) => {
      clearHide()
      const current = hitRef.current
      const same = current?.dom === next.dom && current.kind === next.kind
      hitRef.current = next
      if (!same) {
        setHit(next)
        setCopied(false)
        setOpen(false)
      }
      placeRef.current(next.dom)
    }
    const consider = (target: EventTarget | null) => {
      if (editor.isDestroyed) return
      const next = blockHitAt(editor.view, target)
      if (next) show(next)
      else hide()
    }
    const remember = (event: PointerEvent) => {
      pointer.current.x = event.clientX
      pointer.current.y = event.clientY
    }
    const onOver = (event: PointerEvent) => {
      remember(event)
      consider(event.target)
    }
    const onOut = (event: PointerEvent) => {
      const next = event.relatedTarget
      if (next instanceof Node && barRef.current?.contains(next)) return
      if (next instanceof Node && root.contains(next) && blockHitAt(editor.view, next)) return
      hide()
    }
    const onScroll = () => {
      const under = elementAt(pointer.current.x, pointer.current.y)
      if (under) consider(under)
      else if (hitRef.current) placeRef.current(hitRef.current.dom)
    }
    const onTx = () => {
      setEditable((prev) => (prev === editor.isEditable ? prev : editor.isEditable))
      const current = hitRef.current
      if (!current) return
      if (!current.dom.isConnected) {
        hitRef.current = null
        setHit(null)
        setBox(null)
        return
      }
      const again = blockHitAt(editor.view, current.dom)
      if (!again) {
        hitRef.current = null
        setHit(null)
        setBox(null)
        return
      }
      hitRef.current = again
      setHit((prev) => (prev?.dom === again.dom && prev.kind === again.kind ? prev : again))
      placeRef.current(again.dom)
    }

    root.addEventListener('pointerover', onOver)
    root.addEventListener('pointerout', onOut)
    const scroll = root.closest('.editor-scroll')
    scroll?.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll)
    editor.on('transaction', onTx)
    return () => {
      clearHide()
      root.removeEventListener('pointerover', onOver)
      root.removeEventListener('pointerout', onOut)
      scroll?.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
      editor.off('transaction', onTx)
    }
  }, [editor])

  useEffect(() => () => {
    if (copiedTimer.current != null) clearTimeout(copiedTimer.current)
  }, [])

  function currentPos(): number | null {
    const current = hitRef.current
    if (!current || editor.isDestroyed || !current.dom.isConnected) return null
    return blockHitAt(editor.view, current.dom)?.pos ?? null
  }

  async function onCopy() {
    const pos = currentPos()
    if (pos === null) return
    const ok = await copyBlock(editor, pos)
    if (!ok) return
    setCopied(true)
    if (copiedTimer.current != null) clearTimeout(copiedTimer.current)
    copiedTimer.current = setTimeout(() => {
      copiedTimer.current = null
      setCopied(false)
    }, COPIED_MS)
  }

  async function onCut() {
    const pos = currentPos()
    if (pos === null) return
    await cutBlock(editor, pos)
  }

  function onDelete() {
    const pos = currentPos()
    if (pos === null) return
    deleteBlock(editor, pos)
  }

  if (!hit || !box) return null
  const copyLabel = copied ? t('editor.copied') : t('editor.block.copy')
  const toggleLabel = open ? t('editor.block.close') : t('editor.block.open')

  return (
    <div
      ref={barRef}
      className="editor-block-actions"
      data-testid="block-actions"
      data-kind={hit.kind}
      data-open={open ? 'true' : 'false'}
      role="group"
      aria-label={t('editor.block.actions')}
      style={{ top: box.top, left: box.left }}
      onPointerEnter={() => api.current.clearHide()}
      onPointerLeave={(event) => {
        const next = event.relatedTarget
        if (next instanceof Node && !editor.isDestroyed && editor.view.dom.contains(next)) return
        api.current.hide()
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || !open) return
        event.stopPropagation()
        setOpen(false)
      }}
    >
      <Tip content={toggleLabel} side="left">
        <button
          type="button"
          className="editor-block-action is-toggle"
          data-testid="block-action-toggle"
          aria-label={toggleLabel}
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <Mark icon={EllipsisVertical} size={16} />
        </button>
      </Tip>
      {open ? (
        <>
          <Tip content={copyLabel} side="left">
            <button
              type="button"
              className="editor-block-action"
              data-testid="block-action-copy"
              aria-label={copyLabel}
              onClick={() => void onCopy()}
            >
              <Mark icon={copied ? Check : Copy} size={16} />
            </button>
          </Tip>
          <Tip content={t('editor.block.cut')} side="left">
            <button
              type="button"
              className="editor-block-action"
              data-testid="block-action-cut"
              aria-label={t('editor.block.cut')}
              disabled={!editable}
              onClick={() => void onCut()}
            >
              <Mark icon={Scissors} size={16} />
            </button>
          </Tip>
          <Tip content={t('editor.block.delete')} side="left">
            <button
              type="button"
              className="editor-block-action is-danger"
              data-testid="block-action-delete"
              aria-label={t('editor.block.delete')}
              disabled={!editable}
              onClick={onDelete}
            >
              <Mark icon={Trash2} size={16} />
            </button>
          </Tip>
        </>
      ) : null}
    </div>
  )
}

function sameBox(prev: BlockBox | null, next: BlockBox | null): boolean {
  if (prev === next) return true
  if (!prev || !next) return false
  return prev.top === next.top && prev.left === next.left
}
