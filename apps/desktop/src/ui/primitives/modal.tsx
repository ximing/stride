import * as Dialog from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useMemo,
  useRef,
  type ComponentPropsWithoutRef,
  type ReactNode,
  type RefObject,
} from 'react'
import { useTranslation } from 'react-i18next'
import { Mark } from './icon'
import { useLayer } from './layer'

const ModalContext = createContext<{
  triggerRef: RefObject<HTMLButtonElement | null>
  open?: boolean
} | null>(null)

function activeFocusTarget(): HTMLElement | null {
  if (typeof document === 'undefined') return null
  const active = document.activeElement
  return active instanceof HTMLElement && active !== document.body ? active : null
}

function canRestoreFocus(target: HTMLElement | null): target is HTMLElement {
  if (!target?.isConnected || target === target.ownerDocument.body) return false
  if (target.matches(':disabled') || target.closest('[hidden], [inert]')) return false
  const style = target.ownerDocument.defaultView?.getComputedStyle(target)
  return !style || (style.display !== 'none' && style.visibility !== 'hidden')
}

export function useDialogFocusRestore(open = true) {
  const returnFocusRef = useRef<HTMLElement | null>(null)
  const wasOpenRef = useRef(false)

  // Capture before Radix moves focus into the dialog. Keep the target through
  // the closing render so onCloseAutoFocus can still use it.
  if (open && !wasOpenRef.current) returnFocusRef.current = activeFocusTarget()
  wasOpenRef.current = open

  return useCallback((event: Event) => {
    const target = returnFocusRef.current
    if (!canRestoreFocus(target)) return
    event.preventDefault()
    target.focus()
  }, [])
}

export function Modal(props: ComponentPropsWithoutRef<typeof Dialog.Root>) {
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const context = useMemo(() => ({ triggerRef, open: props.open }), [props.open])
  return (
    <ModalContext.Provider value={context}>
      <Dialog.Root {...props} />
    </ModalContext.Provider>
  )
}

export const ModalTrigger = forwardRef<HTMLButtonElement, ComponentPropsWithoutRef<typeof Dialog.Trigger>>(
  function ModalTrigger(props, forwardedRef) {
    const context = useContext(ModalContext)
    const setTriggerRef = useCallback(
      (node: HTMLButtonElement | null) => {
        if (context) context.triggerRef.current = node
        if (typeof forwardedRef === 'function') forwardedRef(node)
        else if (forwardedRef) forwardedRef.current = node
      },
      [context, forwardedRef],
    )
    return <Dialog.Trigger {...props} ref={setTriggerRef} />
  },
)
export const ModalClose = Dialog.Close

export type ModalContentProps = Omit<ComponentPropsWithoutRef<typeof Dialog.Content>, 'title'> & {
  title: ReactNode
  description?: ReactNode
  children?: ReactNode
  size?: 'sm' | 'md' | 'lg'
  /** False: no shared close button, and overlay / Escape do not dismiss. */
  dismissible?: boolean
}

export const ModalContent = forwardRef<HTMLDivElement, ModalContentProps>(function ModalContent(
  {
    title,
    description,
    children,
    className,
    size = 'md',
    dismissible = true,
    'aria-describedby': ariaDescribedBy,
    onCloseAutoFocus,
    onEscapeKeyDown,
    onPointerDownOutside,
    onInteractOutside,
    ...props
  },
  ref,
) {
  const { t } = useTranslation()
  const layer = useLayer()
  const modal = useContext(ModalContext)
  const restoreFocus = useDialogFocusRestore(modal?.open ?? true)
  const descriptionProps = description
    ? ariaDescribedBy !== undefined ? { 'aria-describedby': ariaDescribedBy } : {}
    : { 'aria-describedby': undefined }
  const keepOpen = (event: { preventDefault: () => void }) => {
    if (!dismissible) event.preventDefault()
  }

  return (
    <Dialog.Portal container={layer ?? undefined}>
      <Dialog.Overlay className="sd-overlay" />
      <Dialog.Content
        ref={ref}
        className={['sd-modal', dismissible ? '' : 'sd-modal-no-dismiss', `sd-modal-${size}`, className].filter(Boolean).join(' ')}
        {...descriptionProps}
        {...props}
        onEscapeKeyDown={(event) => {
          onEscapeKeyDown?.(event)
          keepOpen(event)
        }}
        onPointerDownOutside={(event) => {
          onPointerDownOutside?.(event)
          keepOpen(event)
        }}
        onInteractOutside={(event) => {
          onInteractOutside?.(event)
          keepOpen(event)
        }}
        onCloseAutoFocus={(event) => {
          onCloseAutoFocus?.(event)
          if (!event.defaultPrevented && !modal?.triggerRef.current) restoreFocus(event)
        }}
      >
        <Dialog.Title className="sd-modal-title">{title}</Dialog.Title>
        {description ? <Dialog.Description className="sd-modal-copy">{description}</Dialog.Description> : null}
        {children}
        {dismissible ? (
          <Dialog.Close className="sd-modal-x" aria-label={t('common.close')}>
            <Mark icon={X} size={16} />
          </Dialog.Close>
        ) : null}
      </Dialog.Content>
    </Dialog.Portal>
  )
})
