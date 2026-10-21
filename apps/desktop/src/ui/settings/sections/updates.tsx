// Updates settings section (T7.2, FEATURES 9.7; wired to the real updater in
// T8.3). Stores the update channel, the automatic-check switch, and the
// releases URL through the existing SettingsService form + save() round-trip.
// UpdateService reads the saved form at check time, so channel/URL changes
// apply to the very next check and the autoCheck switch gates the launch
// timer as soon as it is saved.

import { observer, useService } from '@rabjs/react'
import type { UpdateChannel } from '@stride/core'
import { CircleAlert, CircleCheck } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { SettingsService } from '../../../services/settings/settings.service'
import { Button } from '../../primitives/button'
import { Mark } from '../../primitives/icon'
import { Input } from '../../primitives/input'
import './updates.css'

// Empty means the channel default feed. Anything else must be a real http(s)
// URL: either a tauri static latest.json or a GitHub release API URL.
function releasesUrlInvalid(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed === '') return false
  try {
    const url = new URL(trimmed)
    if (url.protocol === 'http:' || url.protocol === 'https:') return false
  } catch {
    // fall through to the error
  }
  return true
}

type SaveStatus = '' | 'saved' | 'invalid'

export const UpdatesSection = observer(function UpdatesSection() {
  const { t } = useTranslation()
  const settings = useService(SettingsService)
  const [channel, setChannel] = useState<UpdateChannel>(settings.form.updates.channel)
  const [autoCheck, setAutoCheck] = useState(settings.form.updates.autoCheck)
  const [releasesUrl, setReleasesUrl] = useState(settings.form.releasesUrl)
  const [urlError, setUrlError] = useState(false)
  const [status, setStatus] = useState<SaveStatus>('')

  const save = async () => {
    const invalid = releasesUrlInvalid(releasesUrl)
    setUrlError(invalid)
    if (invalid) {
      setStatus('invalid')
      return
    }
    setStatus('')
    settings.setReleasesUrl(releasesUrl.trim())
    settings.form = { ...settings.form, updates: { channel, autoCheck } }
    await settings.save()
    if (settings.notice) setStatus('')
    else setStatus('saved')
  }

  const statusText = status === 'saved' ? t('common.saved') : status === 'invalid' ? t('common.fixField') : ''

  return (
    <div className="supd" data-testid="settings-section-updates">
      <div className="supd-field">
        <span className="supd-label" id="settings-updates-channel-label">
          {t('settings.updates.channel')}
        </span>
        <div className="supd-radios" role="radiogroup" aria-labelledby="settings-updates-channel-label">
          <label className="supd-radio settings-choice">
            <input
              className="settings-choice-control"
              type="radio"
              name="settings-updates-channel"
              data-testid="settings-updates-channel-stable"
              checked={channel === 'stable'}
              onChange={() => {
                setChannel('stable')
                setStatus('')
              }}
            />
            <span>
              <span className="supd-radio-label">{t('settings.updates.stable')}</span>
              <span className="supd-hint">{t('settings.updates.stableHint')}</span>
            </span>
          </label>
          <label className="supd-radio settings-choice">
            <input
              className="settings-choice-control"
              type="radio"
              name="settings-updates-channel"
              data-testid="settings-updates-channel-beta"
              checked={channel === 'beta'}
              onChange={() => {
                setChannel('beta')
                setStatus('')
              }}
            />
            <span>
              <span className="supd-radio-label">{t('settings.updates.beta')}</span>
              <span className="supd-hint">{t('settings.updates.betaHint')}</span>
            </span>
          </label>
        </div>
      </div>
      <div className="supd-field">
        <label className="supd-check settings-choice">
          <input
            className="settings-choice-control"
            type="checkbox"
            data-testid="settings-updates-auto-check"
            checked={autoCheck}
            onChange={(event) => {
              setAutoCheck(event.target.checked)
              setStatus('')
            }}
          />
          <span className="supd-check-label">{t('settings.updates.auto')}</span>
        </label>
        <p className="supd-hint">{t('settings.updates.autoHint')}</p>
      </div>
      <div className="supd-field">
        <Input
          id="settings-updates-releases-url-input"
          label={t('settings.updates.releasesUrl')}
          className="supd-input"
          type="text"
          autoComplete="off"
          placeholder="https://api.github.com/repos/owner/repo/releases/tags/latest"
          data-testid="settings-updates-releases-url"
          value={releasesUrl}
          aria-invalid={urlError ? true : undefined}
          aria-describedby={urlError ? undefined : 'settings-updates-releases-url-hint'}
          aria-errormessage={urlError ? 'settings-updates-releases-url-error' : undefined}
          onChange={(event) => {
            setReleasesUrl(event.target.value)
            if (urlError && !releasesUrlInvalid(event.target.value)) setUrlError(false)
            setStatus('')
          }}
        />
        {urlError ? (
          <p className="supd-error" id="settings-updates-releases-url-error" role="alert" data-testid="settings-updates-releases-url-error">
            {t('settings.updates.releasesError')}
          </p>
        ) : (
          <p className="supd-hint" id="settings-updates-releases-url-hint">
            {t('settings.updates.releasesHint')}
          </p>
        )}
      </div>
      <p className="supd-note" data-testid="settings-updates-note">
        {t('settings.updates.note')}
      </p>
      <div className="supd-actions">
        <Button tone="primary" size="lg" data-testid="settings-updates-save" onClick={() => void save()}>
          {t('common.save')}
        </Button>
        {statusText && (
          <p className="supd-status" data-tone={status === 'saved' ? 'success' : 'error'} data-testid="settings-updates-status" role="status">
            <Mark icon={status === 'saved' ? CircleCheck : CircleAlert} size={14} />
            <span>{statusText}</span>
          </p>
        )}
        {settings.notice && (
          <p className="supd-error" data-testid="settings-updates-notice" role="alert">
            {settings.notice}
          </p>
        )}
      </div>
    </div>
  )
})
