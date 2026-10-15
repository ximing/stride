import { Sparkle } from '@phosphor-icons/react/Sparkle'
import { ComingSoonSection } from './placeholder'

export function AiSection() {
  return (
    <ComingSoonSection
      icon={Sparkle}
      title="Coming soon"
      body="LLM provider management moves here from the old settings panel in T7.2."
      testId="settings-section-ai"
    />
  )
}
