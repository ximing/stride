import * as SelectPrimitive from '@radix-ui/react-select'
import { Check, ChevronDown } from 'lucide-react'
import { forwardRef, useId, type ReactNode } from 'react'
import { useLayer } from './layer'

export type SelectOption = {
  value: string
  label: string
  disabled?: boolean
  testId?: string
  /** CSS font-family for this row, so a font picker can preview the face. */
  fontFamily?: string
}

export type SelectProps = Omit<SelectPrimitive.SelectTriggerProps, 'children' | 'value'> & {
  label?: ReactNode
  value: string
  onValueChange: (value: string) => void
  options: readonly SelectOption[]
  placeholder?: string
  disabled?: boolean
  onOpenChange?: (open: boolean) => void
}

export const Select = forwardRef<HTMLButtonElement, SelectProps>(function Select(
  { label, value, onValueChange, options, placeholder, disabled, id, className, onOpenChange, ...triggerProps },
  ref,
) {
  const autoId = useId()
  const fieldId = id ?? autoId
  const layer = useLayer()

  return (
    <div className="sd-field sd-select-field">
      {label ? <label className="sd-field-label" htmlFor={fieldId}>{label}</label> : null}
      <SelectPrimitive.Root value={value} onValueChange={onValueChange} disabled={disabled} onOpenChange={onOpenChange}>
        <SelectPrimitive.Trigger
          ref={ref}
          id={fieldId}
          className={['sd-select-trigger', className].filter(Boolean).join(' ')}
          disabled={disabled}
          {...triggerProps}
        >
          <SelectPrimitive.Value placeholder={placeholder} />
          <SelectPrimitive.Icon className="sd-select-icon">
            <ChevronDown aria-hidden="true" size={16} strokeWidth={1.75} />
          </SelectPrimitive.Icon>
        </SelectPrimitive.Trigger>
        <SelectPrimitive.Portal container={layer ?? undefined}>
          <SelectPrimitive.Content
            className="sd-select-content"
            position="popper"
            sideOffset={4}
            collisionPadding={8}
          >
            <SelectPrimitive.Viewport className="sd-select-viewport">
              {options.map((option) => (
                <SelectPrimitive.Item
                  key={option.value}
                  value={option.value}
                  disabled={option.disabled}
                  className="sd-select-item"
                  data-testid={option.testId}
                  style={option.fontFamily ? { fontFamily: option.fontFamily } : undefined}
                >
                  <SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
                  <SelectPrimitive.ItemIndicator className="sd-select-item-indicator">
                    <Check aria-hidden="true" size={14} strokeWidth={1.75} />
                  </SelectPrimitive.ItemIndicator>
                </SelectPrimitive.Item>
              ))}
            </SelectPrimitive.Viewport>
          </SelectPrimitive.Content>
        </SelectPrimitive.Portal>
      </SelectPrimitive.Root>
    </div>
  )
})
