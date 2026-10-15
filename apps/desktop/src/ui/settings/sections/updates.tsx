// Updates settings section (T7.2, FEATURES 9.7). Stores the update channel,
// the automatic-check switch, and the releases URL through the existing
// SettingsService form + save() round-trip. The updater itself
// (tauri-plugin-updater + static latest.json, AD-2) ships in Phase 8 — this
// section only persists preferences, so edits stay in local drafts until Save.

import { observer, useService } from '@rabjs/react'
import { useState } from 'react'
import type { UpdateChannel } from '@stride/core'
import { SettingsService } from '../../../services/panels.service'
import './updates.css'

// Empty means the built-in default endpoint. Anything else must be a real
// http(s) URL the updater can poll later.
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
        <p className="supd-hint">When on, Stride checks the selected channel at launch.</p>
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
          placeholder="https://github.com/owner/repo/releases"
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
          <p className="supd-hint">Where release metadata is fetched from. Leave empty to use the built-in default.</p>
        )}
      </div>
      <p className="supd-note" data-testid="settings-updates-note">
        The updater itself ships in a later release (tauri-plugin-updater with a static latest.json). Until then this
        section only stores your preferences.
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
