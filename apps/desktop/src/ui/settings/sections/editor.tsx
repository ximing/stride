// Editor settings: autosave debounce (app-wide, settings file).

import { has, observer, useService } from '@rabjs/react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { SettingsService } from '../../../services/settings/settings.service'
import { VaultService } from '../../../services/vault/vault.service'
import { Input } from '../../primitives/input'
import './editor.css'

const AUTOSAVE_DEBOUNCE_MIN = 100
const AUTOSAVE_DEBOUNCE_MAX = 5000

const AutosaveField = observer(function AutosaveField() {
  const { t } = useTranslation()
  const settings = useService(SettingsService)
  const vault = useService(VaultService)
  const [draft, setDraft] = useState<string | null>(null)
  const [invalid, setInvalid] = useState(false)
  const error = invalid
    ? t('settings.editor.debounceError', { min: AUTOSAVE_DEBOUNCE_MIN, max: AUTOSAVE_DEBOUNCE_MAX })
    : ''

  const onChange = (text: string) => {
    setDraft(text)
    const parsed = Number(text)
    if (text.trim() === '' || !Number.isInteger(parsed) || parsed < AUTOSAVE_DEBOUNCE_MIN || parsed > AUTOSAVE_DEBOUNCE_MAX) {
      setInvalid(true)
      return
    }
    setInvalid(false)
    settings.form = { ...settings.form, editor: { ...settings.form.editor, autosaveDebounceMs: parsed } }
    // Push straight into VaultService so the next edit's timer uses it.
    vault.setAutosaveDebounceMs(parsed)
    void settings.save()
  }

  return (
    <div className="editor-group">
      <h3 className="editor-heading">{t('settings.editor.autosave')}</h3>
      <div className="editor-field">
        <Input
          label={t('settings.editor.debounce')}
          className="editor-input"
          data-testid="autosave-debounce"
          type="number"
          inputMode="numeric"
          min={AUTOSAVE_DEBOUNCE_MIN}
          max={AUTOSAVE_DEBOUNCE_MAX}
          step={50}
          value={draft ?? String(settings.form.editor.autosaveDebounceMs)}
          aria-invalid={Boolean(error)}
          aria-describedby="autosave-debounce-hint"
          aria-errormessage={error ? 'autosave-debounce-error' : undefined}
          onChange={(event) => onChange(event.target.value)}
        />
      </div>
      <p className="editor-hint" id="autosave-debounce-hint">
        {t('settings.editor.debounceHint', { min: AUTOSAVE_DEBOUNCE_MIN, max: AUTOSAVE_DEBOUNCE_MAX })}
      </p>
      {error && (
        <p className="error" id="autosave-debounce-error" role="alert" data-testid="autosave-debounce-error">
          {error}
        </p>
      )}
      {settings.notice && (
        <p className="error" role="alert" data-testid="editor-notice">
          {settings.notice}
        </p>
      )}
    </div>
  )
})

export function EditorSection() {
  const { t } = useTranslation()
  return (
    <section className="editor-section" data-testid="settings-section-editor" aria-label={t('settings.editor.region')}>
      {has(SettingsService) && has(VaultService) ? <AutosaveField /> : null}
    </section>
  )
}
