// Privacy settings: telemetry opt-in placeholder. No telemetry is collected
// in this version; the switch only persists the preference.

import { has, observer, useService } from '@rabjs/react'
import { SettingsService } from '../../../services/panels.service'
import './privacy.css'

const TelemetryToggle = observer(function TelemetryToggle() {
  const settings = useService(SettingsService)
  return (
    <div className="privacy-group">
      <h3 className="privacy-heading">Telemetry</h3>
      <label className="privacy-toggle settings-choice">
        <input
          className="settings-choice-control"
          type="checkbox"
          data-testid="telemetry-enabled"
          checked={settings.form.privacy.telemetryEnabled}
          onChange={(event) => {
            settings.form = {
              ...settings.form,
              privacy: { ...settings.form.privacy, telemetryEnabled: event.target.checked },
            }
            void settings.save()
          }}
        />
        <span>Allow telemetry</span>
      </label>
      <p className="privacy-hint">
        Stride does not collect any telemetry in this version. This switch only saves your preference for
        when telemetry becomes available — nothing is sent either way.
      </p>
      {settings.notice && (
        <p className="error" role="alert" data-testid="privacy-notice">
          {settings.notice}
        </p>
      )}
    </div>
  )
})

export function PrivacySection() {
  return (
    <section className="privacy-section" data-testid="settings-section-privacy" aria-label="Privacy settings">
      {has(SettingsService) ? <TelemetryToggle /> : null}
    </section>
  )
}
