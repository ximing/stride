// Appearance settings (FEATURES 9.3): theme light/dark/system, note width,
// and editor font size. Theme switching rides the existing ThemeService /
// localStorage mechanism; width and font size dual-write to the settings file
// (SettingsService.save, canonical and git-syncable) and to localStorage
// (stride:appearance) so theme.service.ts can restore them before the first
// paint. All changes apply instantly via CSS variables on <html>.

import { has, observer, useService } from '@rabjs/react'
import type { NoteWidth } from '@stride/core'
import { Monitor, Moon, Sun, type LucideIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import {
  applyAppearance,
  defaultAppearanceStorage,
  isValidNoteFontSize,
  NOTE_FONT_SIZE_MAX,
  NOTE_FONT_SIZE_MIN,
  NOTE_WIDTHS,
  writeStoredAppearance,
  type AppearancePrefs,
} from '../../../services/appearance'
import { SettingsService } from '../../../services/panels.service'
import { THEME_MODES, type ThemeMode } from '../../../services/theme'
import { ThemeService } from '../../../services/theme.service'
import { Input } from '../../input'
import { SettingsSegmentedControl } from '../segmented-control'
import './appearance.css'

const THEME_ICONS: Record<ThemeMode, LucideIcon> = { light: Sun, dark: Moon, system: Monitor }
const THEME_LABELS: Record<ThemeMode, string> = { light: 'Light', dark: 'Dark', system: 'System' }
const WIDTH_LABELS: Record<NoteWidth, string> = { narrow: 'Narrow', standard: 'Standard', wide: 'Wide' }

const THEME_OPTIONS = THEME_MODES.map((mode) => ({ value: mode, label: THEME_LABELS[mode], icon: THEME_ICONS[mode] }))
const WIDTH_OPTIONS = NOTE_WIDTHS.map((width) => ({ value: width, label: WIDTH_LABELS[width] }))

const ThemeGroup = observer(function ThemeGroup() {
  const theme = useService(ThemeService)
  return (
    <div className="appearance-group">
      <h3 className="appearance-heading">Theme</h3>
      <SettingsSegmentedControl
        label="Theme"
        value={theme.mode}
        options={THEME_OPTIONS}
        testIdPrefix="theme"
        onChange={(mode) => theme.setTheme(mode)}
      />
      <p className="appearance-hint">System follows the OS appearance and tracks it live.</p>
    </div>
  )
})

const AppearancePrefsForm = observer(function AppearancePrefsForm() {
  const settings = useService(SettingsService)
  // Local drafts keep invalid input visible without touching applied state.
  const [fontDraft, setFontDraft] = useState<string | null>(null)
  const [fontError, setFontError] = useState('')

  const noteWidth = settings.form.appearance.noteWidth
  const fontSize = settings.form.appearance.fontSize

  // The settings file is canonical: once SettingsService finishes loading,
  // re-apply from form so values synced from another machine take over from
  // the localStorage pre-paint snapshot.
  useEffect(() => {
    if (settings.isLoading) return
    applyAppearance({ noteWidth, fontSize })
    writeStoredAppearance(defaultAppearanceStorage(), { noteWidth, fontSize })
  }, [settings.isLoading, noteWidth, fontSize])

  const patchAppearance = (partial: Partial<AppearancePrefs>) => {
    const next: AppearancePrefs = { ...settings.form.appearance, ...partial }
    settings.form = { ...settings.form, appearance: next }
    applyAppearance(next)
    writeStoredAppearance(defaultAppearanceStorage(), next)
    void settings.save()
  }

  const onFontSizeChange = (text: string) => {
    setFontDraft(text)
    const parsed = Number(text)
    if (text.trim() === '' || !isValidNoteFontSize(parsed)) {
      setFontError(`Font size must be a whole number between ${NOTE_FONT_SIZE_MIN} and ${NOTE_FONT_SIZE_MAX}.`)
      return
    }
    setFontError('')
    patchAppearance({ fontSize: parsed })
  }

  return (
    <>
      <div className="appearance-group">
        <h3 className="appearance-heading">Note width</h3>
        <SettingsSegmentedControl
          label="Note width"
          value={noteWidth}
          options={WIDTH_OPTIONS}
          testIdPrefix="note-width"
          onChange={(width) => patchAppearance({ noteWidth: width })}
        />
        <p className="appearance-hint">Caps the editor column; wide removes the cap.</p>
      </div>
      <div className="appearance-group">
        <div className="appearance-fontsize-field">
          <Input
            label="Font size (px)"
            className="appearance-fontsize-input"
            data-testid="note-font-size"
            type="number"
            inputMode="numeric"
            min={NOTE_FONT_SIZE_MIN}
            max={NOTE_FONT_SIZE_MAX}
            step={1}
            value={fontDraft ?? String(fontSize)}
            aria-invalid={Boolean(fontError)}
            aria-describedby="note-font-size-hint"
            aria-errormessage={fontError ? 'note-font-size-error' : undefined}
            onChange={(event) => onFontSizeChange(event.target.value)}
          />
        </div>
        <p className="appearance-hint" id="note-font-size-hint">
          Editor body text, {NOTE_FONT_SIZE_MIN}–{NOTE_FONT_SIZE_MAX}px. Applies immediately.
        </p>
        {fontError && (
          <p className="error" id="note-font-size-error" role="alert" data-testid="note-font-size-error">
            {fontError}
          </p>
        )}
      </div>
      {settings.notice && (
        <p className="error" role="alert" data-testid="appearance-notice">
          {settings.notice}
        </p>
      )}
    </>
  )
})

export function AppearanceSection() {
  return (
    <section className="appearance-section" data-testid="settings-section-appearance" aria-label="Appearance settings">
      <ThemeGroup />
      {/* SettingsService is registered at app start; tests that mount the page
          without it still get the theme control. */}
      {has(SettingsService) ? <AppearancePrefsForm /> : null}
    </section>
  )
}
