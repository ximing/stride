// Nine-dot color picker shared by the type customize modal and the view
// editor. Colors come from the `--sd-dot-*` tokens only; `auto` (type rail)
// is the "hash from the title" choice and renders as a multi-color gradient.
import { TYPE_COLOR_KEYS } from '@stride/core'

export interface ColorSwatchesProps {
  /** Currently selected color key, '' for none/auto. */
  value: string
  /** Receives the color key, or '' when the selected swatch is clicked again. */
  onChange: (color: string) => void
  /** Adds an "auto" swatch at the front, selected when value matches autoValue. */
  withAuto?: boolean
  autoValue?: string
  /** Accessible labels keyed by color key, plus `auto` when withAuto is set. */
  labels: Record<string, string>
  testId?: string
}

export function ColorSwatches({
  value,
  onChange,
  withAuto = false,
  autoValue = '',
  labels,
  testId = 'color-swatches',
}: ColorSwatchesProps) {
  return (
    <div className="sd-swatches" data-testid={testId}>
      {withAuto && (
        <button
          type="button"
          className="sd-swatch sd-swatch-auto"
          data-testid={`${testId}-auto`}
          data-selected={value === autoValue ? 'true' : undefined}
          aria-label={labels.auto ?? 'Auto'}
          title={labels.auto ?? 'Auto'}
          aria-pressed={value === autoValue}
          onClick={() => onChange(value === autoValue ? '' : autoValue)}
        />
      )}
      {TYPE_COLOR_KEYS.map((color) => (
        <button
          key={color}
          type="button"
          className={`sd-swatch sd-swatch-${color}`}
          data-testid={`${testId}-${color}`}
          data-color={color}
          data-selected={value === color ? 'true' : undefined}
          aria-label={labels[color] ?? color}
          title={labels[color] ?? color}
          aria-pressed={value === color}
          onClick={() => onChange(value === color ? '' : color)}
        />
      ))}
    </div>
  )
}
