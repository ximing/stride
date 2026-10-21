import * as TabsPrimitive from '@radix-ui/react-tabs'
import { forwardRef, type ComponentPropsWithoutRef } from 'react'

export const Tabs = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<typeof TabsPrimitive.Root>>(
  function Tabs({ className, ...props }, ref) {
    return <TabsPrimitive.Root ref={ref} className={['sd-tabs', className].filter(Boolean).join(' ')} {...props} />
  },
)

export const TabsList = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<typeof TabsPrimitive.List>>(
  function TabsList({ className, ...props }, ref) {
    return <TabsPrimitive.List ref={ref} className={['sd-tabs-list', className].filter(Boolean).join(' ')} {...props} />
  },
)

export const TabsTrigger = forwardRef<HTMLButtonElement, ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>>(
  function TabsTrigger({ className, ...props }, ref) {
    return (
      <TabsPrimitive.Trigger
        ref={ref}
        className={['sd-tabs-trigger', className].filter(Boolean).join(' ')}
        {...props}
      />
    )
  },
)

export const TabsContent = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<typeof TabsPrimitive.Content>>(
  function TabsContent({ className, ...props }, ref) {
    return (
      <TabsPrimitive.Content
        ref={ref}
        className={['sd-tabs-content', className].filter(Boolean).join(' ')}
        {...props}
      />
    )
  },
)
