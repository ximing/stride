// This Vault settings section: editor zoom, note-list density, the git setup
// preference, and whether a title change renames the note file. All of them
// live in .stride/vault.json via the read-modify-write helpers in core
// vault-config, so they differ between vaults and travel with the vault
// folder in git. VaultService owns the live values; zoom reaches the stage
// instantly through stage-zoom.ts and viewMode reaches NoteList through the
// `is-compact` class.

import { has, observer, useService } from '@rabjs/react'
import { FolderOpen } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  VAULT_ZOOM_MAX,
  VAULT_ZOOM_MIN,
  type GitSetupPreference,
  type ViewMode,
} from '@stride/core'
import { VaultService } from '../../../services/vault/vault.service'
import { Mark } from '../../primitives/icon'
import { Input } from '../../primitives/input'
import { SettingsSegmentedControl } from '../segmented-control'
import './vault.css'

const VIEW_MODES: readonly ViewMode[] = ['comfortable', 'compact']
const GIT_SETUP_OPTIONS: readonly GitSetupPreference[] = ['undecided', 'enabled', 'disabled']

const ZoomField = observer(function ZoomField() {
  const { t } = useTranslation()
  const vault = useService(VaultService)
  // Local draft keeps invalid input visible without touching applied state.
  const [draft, setDraft] = useState<string | null>(null)
  const [invalid, setInvalid] = useState(false)
  const error = invalid ? t('settings.vault.zoomError', { min: VAULT_ZOOM_MIN, max: VAULT_ZOOM_MAX }) : ''

  const onChange = (text: string) => {
    setDraft(text)
    const parsed = Number(text)
    if (text.trim() === '' || !Number.isFinite(parsed) || parsed < VAULT_ZOOM_MIN || parsed > VAULT_ZOOM_MAX) {
      setInvalid(true)
      return
    }
    setInvalid(false)
    void vault.setZoom(parsed)
  }

  return (
    <div className="svault-group">
      <div className="svault-zoom">
        <Input
          label={t('settings.vault.zoom')}
          className="svault-zoom-input"
          data-testid="vault-zoom"
          type="number"
          inputMode="decimal"
          min={VAULT_ZOOM_MIN}
          max={VAULT_ZOOM_MAX}
          step={0.05}
          value={draft ?? String(vault.zoom)}
          aria-invalid={Boolean(error)}
          aria-describedby="vault-zoom-hint"
          aria-errormessage={error ? 'vault-zoom-error' : undefined}
          onChange={(event) => onChange(event.target.value)}
        />
      </div>
      <p className="svault-hint" id="vault-zoom-hint">
        {t('settings.vault.zoomHint', {
          min: VAULT_ZOOM_MIN,
          max: VAULT_ZOOM_MAX,
          perVault: t('settings.vault.perVault'),
        })}
      </p>
      {error && (
        <p className="error" id="vault-zoom-error" role="alert" data-testid="vault-zoom-error">
          {error}
        </p>
      )}
    </div>
  )
})

const ViewModeField = observer(function ViewModeField() {
  const { t } = useTranslation()
  const vault = useService(VaultService)
  const options = VIEW_MODES.map((mode) => ({ value: mode, label: t(`settings.vault.${mode}`) }))
  return (
    <div className="svault-group">
      <h3 className="svault-heading">{t('settings.vault.density')}</h3>
      <SettingsSegmentedControl
        label={t('settings.vault.density')}
        value={vault.viewMode}
        options={options}
        testIdPrefix="vault-view-mode"
        onChange={(mode) => void vault.setViewMode(mode)}
      />
      <p className="svault-hint">
        {t('settings.vault.densityHint', { perVault: t('settings.vault.perVault') })}
      </p>
    </div>
  )
})

const GitSetupField = observer(function GitSetupField() {
  const { t } = useTranslation()
  const vault = useService(VaultService)
  const labels: Record<GitSetupPreference, string> = {
    undecided: t('settings.vault.undecided'),
    enabled: t('settings.vault.enabled'),
    disabled: t('settings.vault.disabled'),
  }
  return (
    <div className="svault-group">
      <h3 className="svault-heading">{t('settings.vault.gitSetup')}</h3>
      <div className="svault-radios" role="radiogroup" aria-label={t('settings.vault.gitSetupLabel')}>
        {GIT_SETUP_OPTIONS.map((option) => (
          <label key={option} className="svault-radio settings-choice">
            <input
              className="settings-choice-control"
              type="radio"
              name="vault-git-setup"
              data-testid={`vault-git-setup-${option}`}
              checked={vault.gitSetupPreference === option}
              onChange={() => void vault.setGitSetupPreference(option)}
            />
            <span>{labels[option]}</span>
          </label>
        ))}
      </div>
      <p className="svault-hint">
        {t('settings.vault.gitSetupHint', { perVault: t('settings.vault.perVault') })}
      </p>
    </div>
  )
})

const RenameFromHeadingField = observer(function RenameFromHeadingField() {
  const { t } = useTranslation()
  const vault = useService(VaultService)
  return (
    <div className="svault-group">
      <h3 className="svault-heading">{t('settings.vault.rename')}</h3>
      <label className="svault-check settings-choice">
        <input
          className="settings-choice-control"
          type="checkbox"
          data-testid="settings-rename-from-heading"
          checked={vault.renameFromHeading}
          onChange={(event) => {
            void vault.setRenameFromHeading(event.target.checked)
          }}
        />
        <span>{t('settings.vault.renameLabel')}</span>
      </label>
      <p className="svault-hint">
        {t('settings.vault.renameHint', { perVault: t('settings.vault.perVault') })}
      </p>
    </div>
  )
})

const VaultFields = observer(function VaultFields() {
  const { t } = useTranslation()
  const vault = useService(VaultService)
  if (vault.phase !== 'ready') {
    return (
      <div className="svault-empty" data-testid="vault-settings-empty">
        <Mark icon={FolderOpen} size={20} />
        <div>
          <p className="svault-empty-title">{t('settings.vault.emptyTitle')}</p>
          <p className="svault-hint">{t('settings.vault.emptyBody')}</p>
        </div>
      </div>
    )
  }
  return (
    <>
      <ZoomField />
      <ViewModeField />
      <GitSetupField />
      <RenameFromHeadingField />
    </>
  )
})

export function VaultSection() {
  const { t } = useTranslation()
  return (
    <section className="svault-section" data-testid="settings-section-vault" aria-label={t('settings.vault.region')}>
      {/* VaultService is registered at app start; tests that mount the page
          without it render the section shell only. */}
      {has(VaultService) ? <VaultFields /> : null}
    </section>
  )
}
