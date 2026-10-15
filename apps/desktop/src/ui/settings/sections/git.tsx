import { GitBranch } from '@phosphor-icons/react/GitBranch'
import { ComingSoonSection } from './placeholder'

export function GitSection() {
  return (
    <ComingSoonSection
      icon={GitBranch}
      title="Coming soon"
      body="Auto pull, auto git, and git path settings move here from the old settings panel in T7.2."
      testId="settings-section-git"
    />
  )
}
