import { useId, type InputHTMLAttributes } from 'react'

type InputProps = InputHTMLAttributes<HTMLInputElement> & {
  label: string
}

export function Input({ label, id, className, ...props }: InputProps) {
  const autoId = useId()
  const fieldId = id ?? autoId
  return (
    <label className="sd-field" htmlFor={fieldId}>
      <span className="sd-field-label">{label}</span>
      <input
        id={fieldId}
        className={['sd-field-input', className].filter(Boolean).join(' ')}
        autoComplete="off"
        {...props}
      />
    </label>
  )
}
