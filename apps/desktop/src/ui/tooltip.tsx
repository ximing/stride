import * as TooltipPrimitive from '@radix-ui/react-tooltip'
import { forwardRef, type ComponentPropsWithoutRef, type ReactNode } from 'react'
import { useLayer } from './layer'

export function TooltipProvider({ children }: { children: ReactNode }) {
  return <TooltipPrimitive.Provider delayDuration={250}>{children}</TooltipPrimitive.Provider>
}

export function Tooltip(props: ComponentPropsWithoutRef<typeof TooltipPrimitive.Root>) {
  return <TooltipPrimitive.Root {...props} />
}

export const TooltipTrigger = TooltipPrimitive.Trigger

export const TooltipContent = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>>(
  function TooltipContent({ className, sideOffset = 6, ...props }, ref) {
    const layer = useLayer()
    return (
      <TooltipPrimitive.Portal container={layer ?? undefined}>
        <TooltipPrimitive.Content
          ref={ref}
          className={['sd-tooltip', className].filter(Boolean).join(' ')}
          sideOffset={sideOffset}
          {...props}
        />
      </TooltipPrimitive.Portal>
    )
  },
)
