import type { Icon } from '@phosphor-icons/react'
import { EmptyState } from '../../empty-state'

/** Shared placeholder for sections whose real forms land in T7.2. */
export function ComingSoonSection({ icon, title, body, testId }: { icon: Icon; title: string; body: string; testId: string }) {
  return <EmptyState icon={icon} title={title} body={body} testId={testId} />
}
