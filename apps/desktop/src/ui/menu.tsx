import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { forwardRef, type ComponentPropsWithoutRef } from 'react'
import { useLayer } from './layer'

export function Menu(props: ComponentPropsWithoutRef<typeof DropdownMenu.Root>) {
  return <DropdownMenu.Root {...props} />
}

export const MenuTrigger = DropdownMenu.Trigger

export const MenuContent = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<typeof DropdownMenu.Content>>(
  function MenuContent({ className, sideOffset = 6, align = 'start', ...props }, ref) {
    const layer = useLayer()
    return (
      <DropdownMenu.Portal container={layer ?? undefined}>
        <DropdownMenu.Content
          ref={ref}
          className={['sd-menu', className].filter(Boolean).join(' ')}
          sideOffset={sideOffset}
          align={align}
          {...props}
        />
      </DropdownMenu.Portal>
    )
  },
)

export const MenuItem = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<typeof DropdownMenu.Item>>(
  function MenuItem({ className, ...props }, ref) {
    return <DropdownMenu.Item ref={ref} className={['sd-menu-item', className].filter(Boolean).join(' ')} {...props} />
  },
)
