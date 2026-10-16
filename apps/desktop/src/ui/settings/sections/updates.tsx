// Updates settings section (T7.2, FEATURES 9.7; wired to the real updater in
// T8.3). Stores the update channel, the automatic-check switch, and the
// releases URL through the existing SettingsService form + save() round-trip.
// UpdateService reads the saved form at check time, so channel/URL changes
// apply to the very next check and the autoCheck switch gates the launch
// timer as soon as it is saved.

import { observer, useService } from '@rabjs/react'
import { useState } from 'react'
import type { UpdateChannel } from '@stride/core'
import { SettingsService } from '../../../services/panels.service'
import './updates.css'

// Empty means the channel default feed. Anything else must be a real http(s)
// URL: either a tauri static latest.json or a GitHub release API URL.
function validateReleasesUrl(text: string): string {
  const trimmed = text.trim()
  if (trimmed === '') return ''
  try {
    const url = new URL(trimmed)
    if (url.protocol === 'http:' || url.protocol === 'https:') return ''
  } catch {
    // fall through to the error
  }
  return 'Enter a valid http(s) URL, or leave empty for the default.'
}

export const UpdatesSection = observer(function UpdatesSection() {
  const settings = useService(SettingsService)
  const [channel, setChannel] = useState<UpdateChannel>(settings.form.updates.channel)
  const [autoCheck, setAutoCheck] = useState(settings.form.updates.autoCheck)
  const [releasesUrl, setReleasesUrl] = useState(settings.form.releasesUrl)
  const [urlError, setUrlError] = useState('')
  const [status, setStatus] = useState('')

  const save = async () => {
    const error = validateReleasesUrl(releasesUrl)
    setUrlError(error)
    if (error) {
      setStatus('Fix the highlighted field before saving.')
      return
    }
    setStatus('')
    settings.setReleasesUrl(releasesUrl.trim())
    settings.form = { ...settings.form, updates: { channel, autoCheck } }
    await settings.save()
    if (settings.notice) setStatus('')
    else setStatus('Saved.')
  }

  return (
    <div className="supd" data-testid="settings-section-updates">
      <div className="supd-field">
        <span className="supd-label" id="settings-updates-channel-label">
          Update channel
        </span>
        <div className="supd-radios" role="radiogroup" aria-labelledby="settings-updates-channel-label">
          <label className="supd-radio">
            <input
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
              <span className="supd-radio-label">Stable</span>
              <span className="supd-hint">Recommended. Fully tested releases.</span>
            </span>
          </label>
          <label className="supd-radio">
            <input
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
              <span className="supd-radio-label">Beta</span>
              <span className="supd-hint">Early builds with the latest features; may be less stable.</span>
            </span>
          </label>
        </div>
      </div>
      <div className="supd-field">
        <label className="supd-check">
          <input
            type="checkbox"
            data-testid="settings-updates-auto-check"
            checked={autoCheck}
            onChange={(event) => {
              setAutoCheck(event.target.checked)
              setStatus('')
            }}
          />
          <span className="supd-check-label">Check for updates automatically</span>
        </label>
        <p className="supd-hint">
          When on, Stride silently checks the selected channel a few seconds after launch. Applies the moment you
          save; the next launch obeys the saved value.
        </p>
      </div>
      <div className="supd-field">
        <label className="supd-label" htmlFor="settings-updates-releases-url-input">
          Releases URL
        </label>
        <input
          id="settings-updates-releases-url-input"
          className="supd-input"
          type="text"
          autoComplete="off"
          placeholder="https://api.github.com/repos/owner/repo/releases/tags/latest"
          data-testid="settings-updates-releases-url"
          value={releasesUrl}
          aria-invalid={urlError ? true : undefined}
          onChange={(event) => {
            setReleasesUrl(event.target.value)
            if (urlError && !validateReleasesUrl(event.target.value)) setUrlError('')
            setStatus('')
          }}
        />
        {urlError ? (
          <p className="supd-error" data-testid="settings-updates-releases-url-error">
            {urlError}
          </p>
        ) : (
          <p className="supd-hint">
            Custom endpoint override (a latest.json or GitHub release API URL). Takes priority over the channel;
            leave empty to use the channel feed.
          </p>
        )}
      </div>
      <p className="supd-note" data-testid="settings-updates-note">
        Stable polls the built-in release feed with in-app download and install. Beta polls the beta-latest release
        tag, and a custom URL overrides both; those checks compare versions in-app and hand the download to your
        browser. Saved changes apply to the next update check.
      </p>
      <div className="supd-actions">
        <button type="button" className="supd-save" data-testid="settings-updates-save" onClick={() => void save()}>
          Save
        </button>
        {status && (
          <p className="supd-status" data-testid="settings-updates-status">
            {status}
          </p>
        )}
        {settings.notice && (
          <p className="supd-error" data-testid="settings-updates-notice">
            {settings.notice}
          </p>
        )}
      </div>
    </div>
  )
})
