// This Vault settings section (T7.3, FEATURES 9.8): editor zoom, note-list
// density, and the git setup preference. All three live in .stride/vault.json
// via the read-modify-write helpers in core vault-config, so they differ
// between vaults and travel with the vault folder in git. VaultService owns
// the live values; zoom reaches the stage instantly through stage-zoom.ts and
// viewMode reaches NoteList through the `is-compact` class.

import { FolderOpen } from '@phosphor-icons/react'
import { has, observer, useService } from '@rabjs/react'
import { useState } from 'react'
import {
  VAULT_ZOOM_MAX,
  VAULT_ZOOM_MIN,
  type GitSetupPreference,
  type ViewMode,
} from '../../../../../../packages/core/src/vault-config'
import { VaultService } from '../../../services/vault.service'
import { EmptyState } from '../../empty-state'
import './vault.css'

const PER_VAULT_HINT = 'This vault only — stored in .stride/vault.json and synced with the vault folder.'

const VIEW_MODES: readonly ViewMode[] = ['comfortable', 'compact']
const VIEW_MODE_LABELS: Record<ViewMode, string> = { comfortable: 'Comfortable', compact: 'Compact' }

const GIT_SETUP_OPTIONS: readonly GitSetupPreference[] = ['undecided', 'enabled', 'disabled']
const GIT_SETUP_LABELS: Record<GitSetupPreference, string> = {
  undecided: 'Not decided',
  enabled: 'Set up git',
  disabled: 'No git',
}

const ZoomField = observer(function ZoomField() {
  const vault = useService(VaultService)
  // Local draft keeps invalid input visible without touching applied state.
  const [draft, setDraft] = useState<string | null>(null)
  const [error, setError] = useState('')

  const onChange = (text: string) => {
    setDraft(text)
    const parsed = Number(text)
    if (text.trim() === '' || !Number.isFinite(parsed) || parsed < VAULT_ZOOM_MIN || parsed > VAULT_ZOOM_MAX) {
      setError(`Zoom must be a number between ${VAULT_ZOOM_MIN} and ${VAULT_ZOOM_MAX}.`)
      return
    }
    setError('')
    void vault.setZoom(parsed)
  }

  return (
    <div className="svault-group">
      <h3 className="svault-heading">Zoom</h3>
      <label className="svault-zoom">
        <input
          data-testid="vault-zoom"
          type="number"
          inputMode="decimal"
          min={VAULT_ZOOM_MIN}
          max={VAULT_ZOOM_MAX}
          step={0.05}
          value={draft ?? String(vault.zoom)}
          onChange={(event) => onChange(event.target.value)}
        />
        <span>×</span>
      </label>
      <p className="svault-hint">
        Editor zoom, {VAULT_ZOOM_MIN}–{VAULT_ZOOM_MAX}×. Applies immediately. {PER_VAULT_HINT}
      </p>
      {error && (
        <p className="error" role="alert" data-testid="vault-zoom-error">
          {error}
        </p>
      )}
    </div>
  )
})

const ViewModeField = observer(function ViewModeField() {
  const vault = useService(VaultService)
  return (
    <div className="svault-group">
      <h3 className="svault-heading">Note list density</h3>
      <div className="theme-picker" role="group" aria-label="Note list density">
        {VIEW_MODES.map((mode) => (
          <button
            key={mode}
            type="button"
            data-testid={`vault-view-mode-${mode}`}
            aria-pressed={vault.viewMode === mode}
            onClick={() => void vault.setViewMode(mode)}
          >
            {VIEW_MODE_LABELS[mode]}
          </button>
        ))}
      </div>
      <p className="svault-hint">Compact tightens rows and drops the snippet line. {PER_VAULT_HINT}</p>
    </div>
  )
})

const GitSetupField = observer(function GitSetupField() {
  const vault = useService(VaultService)
  return (
    <div className="svault-group">
      <h3 className="svault-heading">Git setup</h3>
      <div className="svault-radios" role="radiogroup" aria-label="Git setup preference">
        {GIT_SETUP_OPTIONS.map((option) => (
          <label key={option} className="svault-radio">
            <input
              type="radio"
              name="vault-git-setup"
              data-testid={`vault-git-setup-${option}`}
              checked={vault.gitSetupPreference === option}
              onChange={() => void vault.setGitSetupPreference(option)}
            />
            {GIT_SETUP_LABELS[option]}
          </label>
        ))}
      </div>
      <p className="svault-hint">
        Remembered intent for this vault&apos;s git setup; it does not change git behavior yet. {PER_VAULT_HINT}
      </p>
    </div>
  )
})

const VaultFields = observer(function VaultFields() {
  const vault = useService(VaultService)
  if (vault.phase !== 'ready') {
    return (
      <EmptyState
        compact
        icon={FolderOpen}
        title="No vault open"
        body="Open a vault to configure these settings."
        testId="vault-settings-empty"
      />
    )
  }
  return (
    <>
      <ZoomField />
      <ViewModeField />
      <GitSetupField />
    </>
  )
})

export function VaultSection() {
  return (
    <section className="svault-section" data-testid="settings-section-vault" aria-label="This vault settings">
      {/* VaultService is registered at app start; tests that mount the page
          without it render the section shell only. */}
      {has(VaultService) ? <VaultFields /> : null}
    </section>
  )
}
