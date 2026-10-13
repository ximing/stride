import { X } from '@phosphor-icons/react'
import * as Dialog from '@radix-ui/react-dialog'
import { type ComponentPropsWithoutRef, type ReactNode } from 'react'
import { Mark } from './icon'
import { useLayer } from './layer'

export function Modal(props: ComponentPropsWithoutRef<typeof Dialog.Root>) {
  return <Dialog.Root {...props} />
}

export const ModalTrigger = Dialog.Trigger
export const ModalClose = Dialog.Close

export function ModalContent({
  title,
  description,
  children,
}: {
  title: string
  description: string
  children?: ReactNode
}) {
  const layer = useLayer()
  return (
    <Dialog.Portal container={layer ?? undefined}>
      <Dialog.Overlay className="sd-overlay" />
      <Dialog.Content className="sd-modal">
        <Dialog.Title className="sd-modal-title">{title}</Dialog.Title>
        <Dialog.Description className="sd-modal-copy">{description}</Dialog.Description>
        {children}
        <Dialog.Close className="sd-modal-x" aria-label="Close">
          <Mark icon={X} size={16} />
        </Dialog.Close>
      </Dialog.Content>
    </Dialog.Portal>
  )
}
