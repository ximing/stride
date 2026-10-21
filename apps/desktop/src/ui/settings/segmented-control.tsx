import type { LucideIcon } from 'lucide-react'
import { Button } from '../primitives/button'
import { Mark } from '../primitives/icon'

export interface SettingsSegmentedOption<T extends string> {
  value: T
  label: string
  icon?: LucideIcon
}

/** Compact, single-choice settings control. The selected item keeps a visible
 * underline and heavier label in addition to its tinted surface. */
export function SettingsSegmentedControl<T extends string>(props: {
  label: string
  value: T
  options: readonly SettingsSegmentedOption<T>[]
  testIdPrefix: string
  onChange: (value: T) => void
}) {
  return (
    <div className="settings-segmented" role="group" aria-label={props.label}>
      {props.options.map((option) => (
        <Button
          key={option.value}
          tone="quiet"
          size="sm"
          className="settings-segment"
          data-testid={`${props.testIdPrefix}-${option.value}`}
          aria-pressed={props.value === option.value}
          icon={option.icon ? <Mark icon={option.icon} size={16} /> : undefined}
          onClick={() => props.onChange(option.value)}
        >
          {option.label}
        </Button>
      ))}
    </div>
  )
}
