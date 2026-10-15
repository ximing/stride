import { VectorThree } from '@phosphor-icons/react/VectorThree'
import { ComingSoonSection } from './placeholder'

export function EmbeddingSection() {
  return (
    <ComingSoonSection
      icon={VectorThree}
      title="Coming soon"
      body="Embedding endpoint, model, key, and the connection test move here from the old settings panel in T7.2."
      testId="settings-section-embedding"
    />
  )
}
