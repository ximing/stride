import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  tone?: 'primary' | 'quiet' | 'danger'
  icon?: ReactNode
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { tone = 'quiet', icon, className, type = 'button', children, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={['sd-btn', `sd-btn-${tone}`, className].filter(Boolean).join(' ')}
      {...props}
    >
      {icon ? <span className="sd-btn-icon">{icon}</span> : null}
      {children}
    </button>
  )
})
