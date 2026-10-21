import { forwardRef, useId, type InputHTMLAttributes, type ReactNode } from 'react'

export type InputProps = InputHTMLAttributes<HTMLInputElement> & {
  label?: ReactNode
  hint?: ReactNode
  error?: ReactNode
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
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
    <label className="sd-field" htmlFor={fieldId}>
      {label ? <span className="sd-field-label">{label}</span> : null}
      <input
        ref={ref}
        id={fieldId}
        className={['sd-field-input', error ? 'sd-field-input-error' : undefined, className].filter(Boolean).join(' ')}
        autoComplete="off"
        aria-describedby={describedBy}
        aria-invalid={error ? true : ariaInvalid}
        {...props}
      />
      {hint ? <span className="sd-field-hint" id={hintId}>{hint}</span> : null}
      {error ? <span className="sd-field-error" id={errorId}>{error}</span> : null}
    </label>
  )
})
