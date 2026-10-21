import * as Toast from '@radix-ui/react-toast'
import { X } from 'lucide-react'
import { type ReactNode } from 'react'
import { Mark } from './icon'

export function Toaster({ children }: { children: ReactNode }) {
  return (
    <Toast.Provider duration={4200} swipeDirection="right">
      {children}
      <Toast.Viewport className="sd-toast-viewport" />
    </Toast.Provider>
  )
}

export function Notice({
  open,
  onOpenChange,
  title,
  description,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: string
}) {
  return (
    <Toast.Root className="sd-toast" open={open} onOpenChange={onOpenChange}>
      <Toast.Title className="sd-toast-title">{title}</Toast.Title>
      {description ? <Toast.Description className="sd-toast-body">{description}</Toast.Description> : null}
      <Toast.Close className="sd-toast-close" aria-label="Dismiss">
        <Mark icon={X} size={14} />
      </Toast.Close>
    </Toast.Root>
  )
}
