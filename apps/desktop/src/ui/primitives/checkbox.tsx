import { forwardRef, useId, type InputHTMLAttributes, type ReactNode } from 'react'

export type CheckboxProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & {
  label?: ReactNode
  hint?: ReactNode
  error?: ReactNode
}

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { label, hint, error, id, className, 'aria-describedby': ariaDescribedBy, 'aria-invalid': ariaInvalid, ...props },
  ref,
) {
  const autoId = useId()
  const fieldId = id ?? autoId
  const hintId = `${fieldId}-hint`
  const errorId = `${fieldId}-error`
  const describedBy = [ariaDescribedBy, hint ? hintId : undefined, error ? errorId : undefined]
    .filter(Boolean)
    .join(' ') || undefined

  return (
    <label className="sd-checkbox" htmlFor={fieldId}>
      <input
        ref={ref}
        id={fieldId}
        type="checkbox"
        className={['sd-checkbox-input', className].filter(Boolean).join(' ')}
        aria-describedby={describedBy}
        aria-invalid={error ? true : ariaInvalid}
        {...props}
      />
      {label || hint || error ? (
        <span className="sd-checkbox-copy">
          {label ? <span className="sd-checkbox-label">{label}</span> : null}
          {hint ? <span className="sd-field-hint" id={hintId}>{hint}</span> : null}
          {error ? <span className="sd-field-error" id={errorId}>{error}</span> : null}
        </span>
      ) : null}
    </label>
  )
})
