import * as PopoverPrimitive from '@radix-ui/react-popover'
import { forwardRef, type ComponentPropsWithoutRef } from 'react'
import { useLayer } from './layer'

export function Popover(props: ComponentPropsWithoutRef<typeof PopoverPrimitive.Root>) {
  return <PopoverPrimitive.Root {...props} />
}

export const PopoverTrigger = PopoverPrimitive.Trigger

export const PopoverAnchor = PopoverPrimitive.Anchor

export const PopoverContent = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>>(
  function PopoverContent({ className, sideOffset = 6, align = 'start', ...props }, ref) {
    const layer = useLayer()
    return (
      <PopoverPrimitive.Portal container={layer ?? undefined}>
        <PopoverPrimitive.Content
          ref={ref}
          className={['sd-popover', className].filter(Boolean).join(' ')}
          sideOffset={sideOffset}
          align={align}
          {...props}
        />
      </PopoverPrimitive.Portal>
    )
  },
)
