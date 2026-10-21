// Git settings section (T7.2, FEATURES 9.6). Edits live in local drafts until
// Save: the workspace watches SettingsService.form and restarts the git timers
// on any change, so unsaved edits must not leak into form. Save validates the
// numeric drafts, writes the setters, then persists via SettingsService.save()
// — the existing load/save round-trip migrates stored values unchanged.

import { observer, useService } from '@rabjs/react'
import { CircleAlert, CircleCheck } from 'lucide-react'
import { useState } from 'react'
import { SettingsService } from '../../../services/settings/settings.service'
import { Button } from '../../primitives/button'
import { Mark } from '../../primitives/icon'
import { Input } from '../../primitives/input'
import './git.css'

const MAX_AUTO_PULL_MINUTES = 1440
const MAX_AUTO_GIT_SECONDS = 3600

type ParsedNumber = { ok: true; value: number } | { ok: false; error: string }

function parseNonNegativeInt(text: string, max: number): ParsedNumber {
  const trimmed = text.trim()
  if (!/^\d+$/.test(trimmed)) return { ok: false, error: 'Enter a whole number of 0 or more.' }
  const value = Number(trimmed)
  if (!Number.isSafeInteger(value) || value > max) return { ok: false, error: `Must be between 0 and ${max}.` }
  return { ok: true, value }
}

type GitNumberField = 'autoPull' | 'idle' | 'blur'

function NumberRow(props: {
  label: string
  hint: string
  value: string
  error: string
  testId: string
  onChange: (next: string) => void
}) {
  const inputId = `${props.testId}-input`
  const hintId = `${props.testId}-hint`
  const errorId = `${props.testId}-error`
  return (
    <div className="sgit-field">
      <Input
        id={inputId}
        label={props.label}
        className="sgit-input"
        type="text"
        inputMode="numeric"
        autoComplete="off"
        data-testid={props.testId}
        value={props.value}
        aria-invalid={props.error ? true : undefined}
        aria-describedby={props.error ? undefined : hintId}
        aria-errormessage={props.error ? errorId : undefined}
        onChange={(event) => props.onChange(event.target.value)}
      />
      {props.error ? (
        <p className="sgit-error" id={errorId} role="alert" data-testid={errorId}>
          {props.error}
        </p>
      ) : (
        <p className="sgit-hint" id={hintId}>{props.hint}</p>
      )}
    </div>
  )
}

function ToggleRow(props: {
  label: string
  hint: string
  checked: boolean
  testId: string
  onChange: (next: boolean) => void
}) {
  return (
    <div className="sgit-field">
      <label className="sgit-check settings-choice">
        <input
          className="settings-choice-control"
          type="checkbox"
          data-testid={props.testId}
          checked={props.checked}
          onChange={(event) => props.onChange(event.target.checked)}
        />
        <span className="sgit-check-label">{props.label}</span>
      </label>
      <p className="sgit-hint">{props.hint}</p>
    </div>
  )
}

export const GitSection = observer(function GitSection() {
  const settings = useService(SettingsService)
  const [gitEnabled, setGitEnabled] = useState(settings.form.gitEnabled)
  const [autoPull, setAutoPull] = useState(String(settings.form.autoSyncMinutes))
  const [autoGitEnabled, setAutoGitEnabled] = useState(settings.form.autoGitEnabled)
  const [idle, setIdle] = useState(String(settings.form.autoGitIdleSeconds))
  const [blur, setBlur] = useState(String(settings.form.autoGitBlurSeconds))
  const [errors, setErrors] = useState<Record<GitNumberField, string>>({ autoPull: '', idle: '', blur: '' })
  const [status, setStatus] = useState('')

  const setDraft = (field: GitNumberField, next: string) => {
    if (field === 'autoPull') setAutoPull(next)
    else if (field === 'idle') setIdle(next)
    else setBlur(next)
    // Clear the error as soon as the draft parses again.
    const max = field === 'autoPull' ? MAX_AUTO_PULL_MINUTES : MAX_AUTO_GIT_SECONDS
    const parsed = parseNonNegativeInt(next, max)
    setErrors((prev) => ({ ...prev, [field]: parsed.ok ? '' : prev[field] }))
  }

  const save = async () => {
    const autoPullParsed = parseNonNegativeInt(autoPull, MAX_AUTO_PULL_MINUTES)
    const idleParsed = parseNonNegativeInt(idle, MAX_AUTO_GIT_SECONDS)
    const blurParsed = parseNonNegativeInt(blur, MAX_AUTO_GIT_SECONDS)
    setErrors({
      autoPull: autoPullParsed.ok ? '' : autoPullParsed.error,
      idle: idleParsed.ok ? '' : idleParsed.error,
      blur: blurParsed.ok ? '' : blurParsed.error,
    })
    if (!autoPullParsed.ok || !idleParsed.ok || !blurParsed.ok) {
      setStatus('Fix the highlighted fields before saving.')
      return
    }
    setStatus('')
    settings.setGitEnabled(gitEnabled)
    settings.setAutoSyncMinutes(autoPullParsed.value)
    settings.setAutoGitEnabled(autoGitEnabled)
    settings.setAutoGitIdleSeconds(idleParsed.value)
    settings.setAutoGitBlurSeconds(blurParsed.value)
    await settings.save()
    if (settings.notice) setStatus('')
    else setStatus('Saved.')
  }

  return (
    <div className="sgit" data-testid="settings-section-git">
      <ToggleRow
        label="Enable Git integration"
        hint="Master switch for version control. Off hides the Git panel and stops all background sync."
        checked={gitEnabled}
        testId="settings-git-enabled"
        onChange={(next) => {
          setGitEnabled(next)
          setStatus('')
        }}
      />
      <NumberRow
        label="Auto pull interval (minutes)"
        hint={`Pull from the remote every N minutes. 0 disables auto pull. Max ${MAX_AUTO_PULL_MINUTES} (24h).`}
        value={autoPull}
        error={errors.autoPull}
        testId="settings-git-auto-pull"
        onChange={(next) => setDraft('autoPull', next)}
      />
      <ToggleRow
        label="Auto Git"
        hint="Commit and push automatically when you stop typing or leave the window."
        checked={autoGitEnabled}
        testId="settings-git-autogit-enabled"
        onChange={(next) => {
          setAutoGitEnabled(next)
          setStatus('')
        }}
      />
      <NumberRow
        label="Auto Git idle threshold (seconds)"
        hint={`Commit after this many seconds without typing. 0 disables the idle trigger. Max ${MAX_AUTO_GIT_SECONDS}.`}
        value={idle}
        error={errors.idle}
        testId="settings-git-autogit-idle"
        onChange={(next) => setDraft('idle', next)}
      />
      <NumberRow
        label="Auto Git blur threshold (seconds)"
        hint={`Commit when the window loses focus for at least this many seconds. 0 disables the blur trigger. Max ${MAX_AUTO_GIT_SECONDS}.`}
        value={blur}
        error={errors.blur}
        testId="settings-git-autogit-blur"
        onChange={(next) => setDraft('blur', next)}
      />
      <div className="sgit-actions">
        <Button tone="primary" size="lg" data-testid="settings-git-save" onClick={() => void save()}>
          Save
        </Button>
        {status && (
          <p className="sgit-status" data-tone={status === 'Saved.' ? 'success' : 'error'} data-testid="settings-git-status" role="status">
            <Mark icon={status === 'Saved.' ? CircleCheck : CircleAlert} size={14} />
            <span>{status}</span>
          </p>
        )}
        {settings.notice && (
          <p className="sgit-error" data-testid="settings-git-notice" role="alert">
            {settings.notice}
          </p>
        )}
      </div>
    </div>
  )
})
