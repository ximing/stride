import * as TooltipPrimitive from '@radix-ui/react-tooltip'
import {
  cloneElement,
  forwardRef,
  isValidElement,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from 'react'
import { useLayer } from './layer'

/** How long the pointer rests before a tip opens. The native `title` popup waits about a second. */
export const TIP_OPEN_DELAY_MS = 100

/** After one tip closes, another tip inside this window opens with no extra wait. */
export const TIP_SKIP_DELAY_MS = 400

const providerProps = {
  delayDuration: TIP_OPEN_DELAY_MS,
  skipDelayDuration: TIP_SKIP_DELAY_MS,
  disableHoverableContent: true,
} as const

export function TooltipProvider({ children }: { children: ReactNode }) {
  return <TooltipPrimitive.Provider {...providerProps}>{children}</TooltipPrimitive.Provider>
}

export function Tooltip(props: ComponentPropsWithoutRef<typeof TooltipPrimitive.Root>) {
  return (
    <TooltipPrimitive.Provider {...providerProps}>
      <TooltipPrimitive.Root disableHoverableContent {...props} />
    </TooltipPrimitive.Provider>
  )
}

export const TooltipTrigger = TooltipPrimitive.Trigger

export const TooltipContent = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>>(
  function TooltipContent({ className, sideOffset = 6, collisionPadding = 8, ...props }, ref) {
    const layer = useLayer()
    return (
      <TooltipPrimitive.Portal container={layer ?? undefined}>
        <TooltipPrimitive.Content
          ref={ref}
          className={['sd-tooltip', className].filter(Boolean).join(' ')}
          sideOffset={sideOffset}
          collisionPadding={collisionPadding}
          {...props}
        />
      </TooltipPrimitive.Portal>
    )
  },
)

export type TipProps = {
  /** Bubble text. An empty string, null, or false leaves the child without a tip. */
  content?: ReactNode
  side?: 'top' | 'right' | 'bottom' | 'left'
  align?: 'start' | 'center' | 'end'
  children: ReactElement
}

function tipVisible(content: ReactNode): boolean {
  if (content == null || content === false) return false
  if (typeof content === 'string') return content.trim().length > 0
  return true
}

function isDisabledTrigger(child: ReactElement): boolean {
  return (child.props as { disabled?: boolean }).disabled === true
}

function blockPointer(child: ReactElement): ReactElement {
  const style = (child.props as { style?: CSSProperties }).style
  return cloneElement(child, { style: { ...style, pointerEvents: 'none' } } as Partial<unknown>)
}

/**
 * Fast pointer-hover tip for icon buttons, truncated labels, and other controls.
 * Keyboard focus does not open it, so Escape still reaches the dialog or menu underneath.
 * Renders no extra box around an enabled child, so flex and `asChild` triggers keep their layout.
 */
export function Tip({ content, side = 'top', align = 'center', children }: TipProps) {
  const [open, setOpen] = useState(false)
  const fromPointer = useRef(false)
  if (!isValidElement(children) || !tipVisible(content)) return children
  // A disabled control does not receive pointer events, so the tip listens on a wrapper.
  const trigger = isDisabledTrigger(children) ? (
    <span className="sd-tip-disabled">{blockPointer(children)}</span>
  ) : (
    children
  )
  return (
    <Tooltip
      open={open}
      onOpenChange={(next) => {
        // Keyboard focus must not open a tip. An open tip is the top dismiss layer
        // and would swallow Escape before a dialog or menu can close.
        if (next && !fromPointer.current) return
        setOpen(next)
      }}
    >
      <TooltipTrigger
        asChild
        onPointerMove={() => {
          fromPointer.current = true
        }}
        onPointerLeave={() => {
          fromPointer.current = false
        }}
      >
        {trigger}
      </TooltipTrigger>
      <TooltipContent side={side} align={align}>
        {content}
      </TooltipContent>
    </Tooltip>
  )
}

let floating: HTMLDivElement | null = null
let floatingOwner: HTMLElement | null = null
let floatingGeneration = 0
let floatingScroll = false

function hideFloating(anchor: HTMLElement) {
  if (floatingOwner !== anchor) return
  floatingGeneration += 1
  floatingOwner = null
  if (floating) floating.hidden = true
}

function placeFloating(node: HTMLDivElement, anchor: HTMLElement) {
  node.hidden = false
  node.style.visibility = 'hidden'
  const anchorRect = anchor.getBoundingClientRect()
  const tipRect = node.getBoundingClientRect()
  const gap = 6
  let top = anchorRect.top - tipRect.height - gap
  if (top < 8) top = anchorRect.bottom + gap
  const maxLeft = Math.max(8, window.innerWidth - tipRect.width - 8)
  const left = Math.min(Math.max(8, anchorRect.left + anchorRect.width / 2 - tipRect.width / 2), maxLeft)
  node.style.top = `${Math.round(top)}px`
  node.style.left = `${Math.round(left)}px`
  node.style.visibility = 'visible'
}

function ensureFloating(): HTMLDivElement {
  if (floating?.isConnected) return floating
  const node = document.createElement('div')
  node.className = 'sd-tooltip sd-tooltip-floating'
  node.setAttribute('role', 'tooltip')
  node.hidden = true
  document.body.appendChild(node)
  floating = node
  if (!floatingScroll) {
    floatingScroll = true
    window.addEventListener('scroll', () => {
      if (floatingOwner) hideFloating(floatingOwner)
    }, true)
  }
  return node
}

/**
 * The same tip for nodes created outside React (editor widgets).
 * `text` is read when the tip opens, so a locale change is picked up on the next hover.
 * Returns an unbind function.
 */
export function bindElementTip(anchor: HTMLElement, text: () => string): () => void {
  let timer = 0
  const show = () => {
    window.clearTimeout(timer)
    const token = ++floatingGeneration
    floatingOwner = anchor
    timer = window.setTimeout(() => {
      if (token !== floatingGeneration || floatingOwner !== anchor) return
      const label = text().trim()
      if (!label) {
        hideFloating(anchor)
        return
      }
      const node = ensureFloating()
      node.textContent = label
      node.dataset.state = 'instant-open'
      placeFloating(node, anchor)
    }, TIP_OPEN_DELAY_MS)
  }
  const hide = () => {
    window.clearTimeout(timer)
    hideFloating(anchor)
  }
  anchor.addEventListener('pointerenter', show)
  anchor.addEventListener('pointerleave', hide)
  anchor.addEventListener('focusin', show)
  anchor.addEventListener('focusout', hide)
  return () => {
    hide()
    anchor.removeEventListener('pointerenter', show)
    anchor.removeEventListener('pointerleave', hide)
    anchor.removeEventListener('focusin', show)
    anchor.removeEventListener('focusout', hide)
  }
}
