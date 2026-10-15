// Appearance settings (FEATURES 9.3): theme light/dark/system, note width,
// and editor font size. Theme switching rides the existing ThemeService /
// localStorage mechanism; width and font size dual-write to the settings file
// (SettingsService.save, canonical and git-syncable) and to localStorage
// (stride:appearance) so theme.service.ts can restore them before the first
// paint. All changes apply instantly via CSS variables on <html>.

import { Desktop, Moon, Sun } from '@phosphor-icons/react'
import { has, observer, useService } from '@rabjs/react'
import { useEffect, useState } from 'react'
import type { NoteWidth } from '@stride/core'
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
import { Mark } from '../../icon'
import './appearance.css'

const THEME_ICONS: Record<ThemeMode, typeof Sun> = { light: Sun, dark: Moon, system: Desktop }
const THEME_LABELS: Record<ThemeMode, string> = { light: 'Light', dark: 'Dark', system: 'System' }
const WIDTH_LABELS: Record<NoteWidth, string> = { narrow: 'Narrow', standard: 'Standard', wide: 'Wide' }

const ThemeGroup = observer(function ThemeGroup() {
  const theme = useService(ThemeService)
  return (
    <div className="appearance-group">
      <h3 className="appearance-heading">Theme</h3>
      <div className="theme-picker" role="group" aria-label="Theme">
        {THEME_MODES.map((mode) => (
          <button
            key={mode}
            type="button"
            data-testid={`theme-${mode}`}
            aria-pressed={theme.mode === mode}
            onClick={() => theme.setTheme(mode)}
          >
            <Mark icon={THEME_ICONS[mode]} size={16} />
            {THEME_LABELS[mode]}
          </button>
        ))}
      </div>
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
        <div className="theme-picker" role="group" aria-label="Note width">
          {NOTE_WIDTHS.map((width) => (
            <button
              key={width}
              type="button"
              data-testid={`note-width-${width}`}
              aria-pressed={noteWidth === width}
              onClick={() => patchAppearance({ noteWidth: width })}
            >
              {WIDTH_LABELS[width]}
            </button>
          ))}
        </div>
        <p className="appearance-hint">Caps the editor column; wide removes the cap.</p>
      </div>
      <div className="appearance-group">
        <h3 className="appearance-heading">Font size</h3>
        <label className="appearance-fontsize">
          <input
            data-testid="note-font-size"
            type="number"
            inputMode="numeric"
            min={NOTE_FONT_SIZE_MIN}
            max={NOTE_FONT_SIZE_MAX}
            step={1}
            value={fontDraft ?? String(fontSize)}
            onChange={(event) => onFontSizeChange(event.target.value)}
          />
          <span>px</span>
        </label>
        <p className="appearance-hint">
          Editor body text, {NOTE_FONT_SIZE_MIN}–{NOTE_FONT_SIZE_MAX}px. Applies immediately.
        </p>
        {fontError && (
          <p className="error" role="alert" data-testid="note-font-size-error">
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
