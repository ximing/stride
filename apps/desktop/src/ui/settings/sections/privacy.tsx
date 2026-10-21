// Privacy settings: telemetry opt-in placeholder. No telemetry is collected
// in this version; the switch only persists the preference.

import { has, observer, useService } from '@rabjs/react'
import { useTranslation } from 'react-i18next'
import { SettingsService } from '../../../services/settings/settings.service'
import './privacy.css'

const TelemetryToggle = observer(function TelemetryToggle() {
  const { t } = useTranslation()
  const settings = useService(SettingsService)
  return (
    <div className="privacy-group">
      <h3 className="privacy-heading">{t('settings.privacy.telemetry')}</h3>
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
        <span>{t('settings.privacy.allow')}</span>
      </label>
      <p className="privacy-hint">{t('settings.privacy.hint')}</p>
      {settings.notice && (
        <p className="error" role="alert" data-testid="privacy-notice">
          {settings.notice}
        </p>
      )}
    </div>
  )
})

export function PrivacySection() {
  const { t } = useTranslation()
  return (
    <section className="privacy-section" data-testid="settings-section-privacy" aria-label={t('settings.privacy.region')}>
      {has(SettingsService) ? <TelemetryToggle /> : null}
    </section>
  )
}
