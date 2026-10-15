// Editor settings: autosave debounce (app-wide, settings file) and the
// per-vault "rename from H1" toggle (`.stride/vault.json` via VaultService).

import { has, observer, useService } from '@rabjs/react'
import { useState } from 'react'
import { SettingsService } from '../../../services/panels.service'
import { VaultService } from '../../../services/vault.service'
import './editor.css'

const AUTOSAVE_DEBOUNCE_MIN = 100
const AUTOSAVE_DEBOUNCE_MAX = 5000

const AutosaveField = observer(function AutosaveField() {
  const settings = useService(SettingsService)
  const vault = useService(VaultService)
  const [draft, setDraft] = useState<string | null>(null)
  const [error, setError] = useState('')

  const onChange = (text: string) => {
    setDraft(text)
    const parsed = Number(text)
    if (text.trim() === '' || !Number.isInteger(parsed) || parsed < AUTOSAVE_DEBOUNCE_MIN || parsed > AUTOSAVE_DEBOUNCE_MAX) {
      setError(`Debounce must be a whole number between ${AUTOSAVE_DEBOUNCE_MIN} and ${AUTOSAVE_DEBOUNCE_MAX} ms.`)
      return
    }
    setError('')
    settings.form = { ...settings.form, editor: { ...settings.form.editor, autosaveDebounceMs: parsed } }
    // Push straight into VaultService so the next edit's timer uses it.
    vault.setAutosaveDebounceMs(parsed)
    void settings.save()
  }

  return (
    <div className="editor-group">
      <h3 className="editor-heading">Autosave</h3>
      <label className="editor-field">
        <span>Debounce (ms)</span>
        <input
          data-testid="autosave-debounce"
          type="number"
          inputMode="numeric"
          min={AUTOSAVE_DEBOUNCE_MIN}
          max={AUTOSAVE_DEBOUNCE_MAX}
          step={50}
          value={draft ?? String(settings.form.editor.autosaveDebounceMs)}
          onChange={(event) => onChange(event.target.value)}
        />
      </label>
      <p className="editor-hint">
        Pause before an edit is written to disk, {AUTOSAVE_DEBOUNCE_MIN}–{AUTOSAVE_DEBOUNCE_MAX} ms. Applies to new edits.
      </p>
      {error && (
        <p className="error" role="alert" data-testid="autosave-debounce-error">
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

const RenameFromHeadingField = observer(function RenameFromHeadingField() {
  const vault = useService(VaultService)
  const vaultOpen = vault.phase === 'ready'
  return (
    <div className="editor-group">
      <h3 className="editor-heading">Rename from heading</h3>
      <label className="editor-toggle">
        <input
          type="checkbox"
          data-testid="settings-rename-from-heading"
          checked={vault.renameFromHeading}
          disabled={!vaultOpen}
          onChange={(event) => {
            void vault.setRenameFromHeading(event.target.checked)
          }}
        />
        Rename the note file from its first heading (H1)
      </label>
      <p className="editor-hint">
        Stored per vault in .stride/vault.json.
        {vaultOpen ? '' : ' Open a vault to change this setting.'}
      </p>
    </div>
  )
})

export function EditorSection() {
  return (
    <section className="editor-section" data-testid="settings-section-editor" aria-label="Editor settings">
      {has(SettingsService) && has(VaultService) ? <AutosaveField /> : null}
      {has(VaultService) ? <RenameFromHeadingField /> : null}
    </section>
  )
}
