import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import { Mark } from './icon'
import { Tip } from './tooltip'

export type ButtonTone = 'primary' | 'secondary' | 'quiet' | 'danger'
export type ButtonSize = 'sm' | 'md' | 'lg'

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  tone?: ButtonTone
  size?: ButtonSize
  icon?: ReactNode
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { tone = 'secondary', size = 'md', icon, className, type = 'button', children, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={['sd-btn', `sd-btn-${tone}`, `sd-btn-${size}`, className].filter(Boolean).join(' ')}
      {...props}
    >
      {icon ? <span className="sd-btn-icon">{icon}</span> : null}
      {children}
    </button>
  )
})

export type IconButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'title'> & {
  icon: LucideIcon
  label: string
  /** Tip text. Defaults to `label`. This is not the native `title` attribute. */
  title?: string
  active?: boolean
  tone?: ButtonTone
  size?: ButtonSize
  iconSize?: number
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  {
    icon,
    label,
    active,
    tone = 'quiet',
    size = 'md',
    iconSize = 16,
    className,
    title,
    'aria-pressed': ariaPressed,
    ...props
  },
  ref,
) {
  const tip = title?.trim() ? title : label
  return (
    <Tip content={tip}>
      <Button
        ref={ref}
        tone={tone}
        size={size}
        icon={<Mark icon={icon} size={iconSize} />}
        className={['sd-icon-button', active ? 'is-active' : undefined, className].filter(Boolean).join(' ')}
        aria-label={label}
        aria-pressed={active ?? ariaPressed}
        {...props}
      />
    </Tip>
  )
})
