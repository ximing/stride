import type { LucideIcon } from 'lucide-react'
import { Button } from './button'
import { Mark } from './icon'

export interface EmptyStateProps {
  /** Lucide icon. Omit for dense inline hints. */
  icon?: LucideIcon
  title: string
  body?: string
  /** error paints icon and title with --sd-danger. */
  tone?: 'default' | 'error'
  /** Optional primary action. Both label and handler are required to render. */
  actionLabel?: string
  onAction?: () => void
  actionTestId?: string
  /** Compact fits narrow rails, panels and overlay footers. */
  compact?: boolean
  /** Extra class appended to the root (e.g. the full-height stage variant). */
  className?: string
  testId?: string
}

/**
 * The one empty/error state for every panel: icon + one-line title + optional
 * body + optional primary action. All styling lives in `.sd-empty-state`
 * (styles.css) on --sd-* tokens, so light and dark both hold.
 */
export function EmptyState({
  icon,
  title,
  body,
  tone = 'default',
  actionLabel,
  onAction,
  actionTestId,
  compact = false,
  className,
  testId,
}: EmptyStateProps) {
  return (
    <div
      className={[
        compact ? 'sd-empty-state sd-empty-state-compact' : 'sd-empty-state',
        className,
      ].filter(Boolean).join(' ')}
      data-testid={testId}
      data-tone={tone === 'error' ? 'error' : undefined}
    >
      {icon ? (
        <span className="sd-empty-state-icon">
          <Mark icon={icon} size={compact ? 18 : 20} />
        </span>
      ) : null}
      <p className="sd-empty-state-title">{title}</p>
      {body ? <p className="sd-empty-state-body">{body}</p> : null}
      {actionLabel && onAction ? (
        <Button tone="primary" size={compact ? 'sm' : 'md'} className="sd-empty-state-action" data-testid={actionTestId} onClick={onAction}>
          {actionLabel}
        </Button>
      ) : null}
    </div>
  )
}

/**
 * The one loading pattern: pulsing skeleton rows on --sd-* tokens.
 * Panels that stream content progressively (chat, index progress) keep their
 * own inline indicators; everything else waits on this.
 */
export function Skeleton({ rows = 3, testId }: { rows?: number; testId?: string }) {
  return (
    <div className="sd-skeleton" data-testid={testId} aria-hidden="true">
      {Array.from({ length: rows }, (_, index) => (
        <span key={index} className="sd-skeleton-row" />
      ))}
    </div>
  )
}
