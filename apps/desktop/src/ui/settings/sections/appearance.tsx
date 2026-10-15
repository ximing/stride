import { Palette } from '@phosphor-icons/react/Palette'
import { ComingSoonSection } from './placeholder'

export function AppearanceSection() {
  return (
    <ComingSoonSection
      icon={Palette}
      title="Coming soon"
      body="Theme, note width, and font size land here in T7.2. Theme switching already lives in the old settings panel until then."
      testId="settings-section-appearance"
    />
  )
}
