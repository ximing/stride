import { forwardRef, useId, type ReactNode, type TextareaHTMLAttributes } from 'react'

export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  label?: ReactNode
  hint?: ReactNode
  error?: ReactNode
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
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
      <textarea
        ref={ref}
        id={fieldId}
        className={['sd-field-input', 'sd-field-textarea', error ? 'sd-field-input-error' : undefined, className]
          .filter(Boolean)
          .join(' ')}
        aria-describedby={describedBy}
        aria-invalid={error ? true : ariaInvalid}
        {...props}
      />
      {hint ? <span className="sd-field-hint" id={hintId}>{hint}</span> : null}
      {error ? <span className="sd-field-error" id={errorId}>{error}</span> : null}
    </label>
  )
})
