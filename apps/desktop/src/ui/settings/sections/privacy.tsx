import { ShieldCheck } from '@phosphor-icons/react/ShieldCheck'
import { ComingSoonSection } from './placeholder'

export function PrivacySection() {
  return (
    <ComingSoonSection
      icon={ShieldCheck}
      title="Coming soon"
      body="Telemetry stays off by default; the opt-in switch lands here in T7.2."
      testId="settings-section-privacy"
    />
  )
}
