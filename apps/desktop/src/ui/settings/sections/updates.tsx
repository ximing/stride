import { ArrowClockwise } from '@phosphor-icons/react/ArrowClockwise'
import { ComingSoonSection } from './placeholder'

export function UpdatesSection() {
  return (
    <ComingSoonSection
      icon={ArrowClockwise}
      title="Coming soon"
      body="Update channel and automatic checks land here in T7.2."
      testId="settings-section-updates"
    />
  )
}
