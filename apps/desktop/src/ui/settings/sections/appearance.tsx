// Appearance settings (FEATURES 9.3): theme light/dark/system, note width,
// editor font family, and editor font size. Theme switching rides the existing
// ThemeService / localStorage mechanism; width, family, and size dual-write to
// the settings file (SettingsService.save, canonical and git-syncable) and to
// localStorage (stride:appearance) so theme.service.ts can restore them before
// the first paint. All changes apply instantly via CSS variables on <html>.

import { has, observer, useService } from '@rabjs/react'
import { Monitor, Moon, Sun, type LucideIcon } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { normalizeFontFamily } from '@stride/core'
import {
  applyAppearance,
  defaultAppearanceStorage,
  isValidNoteFontSize,
  NOTE_FONT_DEFAULT_CHOICE,
  NOTE_FONT_SIZE_MAX,
  NOTE_FONT_SIZE_MIN,
  noteFontFamilyCss,
  NOTE_WIDTHS,
  writeStoredAppearance,
  type AppearancePrefs,
} from '../../../services/appearance/appearance'
import { listSystemFontFamilies } from '../../../services/platform/fonts'
import { LocaleService } from '../../../services/appearance/locale.service'
import { SettingsService } from '../../../services/settings/settings.service'
import { THEME_MODES, type ThemeMode } from '../../../services/appearance/theme'
import { ThemeService } from '../../../services/appearance/theme.service'
import { Input } from '../../primitives/input'
import { Select } from '../../primitives/select'
import { SettingsSegmentedControl } from '../segmented-control'
import './appearance.css'

const THEME_ICONS: Record<ThemeMode, LucideIcon> = { light: Sun, dark: Moon, system: Monitor }

const LanguageGroup = observer(function LanguageGroup() {
  const { t } = useTranslation()
  const locale = useService(LocaleService)
  const options = [
    { value: 'en' as const, label: t('locale.en') },
    { value: 'zh' as const, label: t('locale.zh') },
  ]
  return (
    <div className="appearance-group">
      <h3 className="appearance-heading">{t('locale.label')}</h3>
      <SettingsSegmentedControl
        label={t('locale.label')}
        value={locale.locale}
        options={options}
        testIdPrefix="locale"
        onChange={(next) => locale.setLocale(next)}
      />
      <p className="appearance-hint">{t('locale.hint')}</p>
    </div>
  )
})

const ThemeGroup = observer(function ThemeGroup() {
  const { t } = useTranslation()
  const theme = useService(ThemeService)
  const options = THEME_MODES.map((mode) => ({
    value: mode,
    label: t(`settings.appearance.${mode}`),
    icon: THEME_ICONS[mode],
  }))
  return (
    <div className="appearance-group">
      <h3 className="appearance-heading">{t('settings.appearance.theme')}</h3>
      <SettingsSegmentedControl
        label={t('settings.appearance.theme')}
        value={theme.mode}
        options={options}
        testIdPrefix="theme"
        onChange={(mode) => theme.setTheme(mode)}
      />
      <p className="appearance-hint">{t('settings.appearance.themeHint')}</p>
    </div>
  )
})

const AppearancePrefsForm = observer(function AppearancePrefsForm() {
  const { t } = useTranslation()
  const settings = useService(SettingsService)
  // Local drafts keep invalid input visible without touching applied state.
  const [fontDraft, setFontDraft] = useState<string | null>(null)
  const [fontInvalid, setFontInvalid] = useState(false)

  const noteWidth = settings.form.appearance.noteWidth
  const fontSize = settings.form.appearance.fontSize
  const fontFamily = settings.form.appearance.fontFamily
  const [families, setFamilies] = useState<readonly string[]>([])
  const [fontsReady, setFontsReady] = useState(false)
  const fontError = fontInvalid
    ? t('settings.appearance.fontError', { min: NOTE_FONT_SIZE_MIN, max: NOTE_FONT_SIZE_MAX })
    : ''
  const widthOptions = NOTE_WIDTHS.map((width) => ({
    value: width,
    label: t(`settings.appearance.${width}`),
  }))

  // The settings file is canonical: once SettingsService finishes loading,
  // re-apply from form so values synced from another machine take over from
  // the localStorage pre-paint snapshot.
  useEffect(() => {
    if (settings.isLoading) return
    applyAppearance({ noteWidth, fontSize, fontFamily })
    writeStoredAppearance(defaultAppearanceStorage(), { noteWidth, fontSize, fontFamily })
  }, [settings.isLoading, noteWidth, fontSize, fontFamily])

  useEffect(() => {
    let cancel = false
    void listSystemFontFamilies()
      .then((next) => {
        if (cancel) return
        setFamilies((current) => (next.length >= current.length ? next : current))
        setFontsReady(true)
      })
      .catch(() => {
        if (!cancel) setFontsReady(true)
      })
    return () => {
      cancel = true
    }
  }, [])

  const patchAppearance = (partial: Partial<AppearancePrefs>) => {
    const next: AppearancePrefs = { ...settings.form.appearance, ...partial }
    settings.form = { ...settings.form, appearance: next }
    applyAppearance(next)
    writeStoredAppearance(defaultAppearanceStorage(), next)
    void settings.save()
  }

  const onFontFamilyChange = (value: string) => {
    const next = value === NOTE_FONT_DEFAULT_CHOICE ? '' : normalizeFontFamily(value)
    if (value !== NOTE_FONT_DEFAULT_CHOICE && !next) return
    patchAppearance({ fontFamily: next })
  }

  const fontOptions = useMemo(() => {
    const preview = (family: string) => `"${family}"`
    const options = [
      {
        value: NOTE_FONT_DEFAULT_CHOICE,
        label: t('settings.appearance.fontFamilyDefault'),
        fontFamily: 'var(--sd-font-serif)',
      },
      ...families.map((family) => ({
        value: family,
        label: family,
        fontFamily: preview(family),
      })),
    ]
    if (fontFamily && !options.some((option) => option.value === fontFamily)) {
      options.splice(1, 0, { value: fontFamily, label: fontFamily, fontFamily: preview(fontFamily) })
    }
    return options
  }, [families, fontFamily, t])

  const onFontSizeChange = (text: string) => {
    setFontDraft(text)
    const parsed = Number(text)
    if (text.trim() === '' || !isValidNoteFontSize(parsed)) {
      setFontInvalid(true)
      return
    }
    setFontInvalid(false)
    patchAppearance({ fontSize: parsed })
  }

  return (
    <>
      <div className="appearance-group">
        <h3 className="appearance-heading">{t('settings.appearance.width')}</h3>
        <SettingsSegmentedControl
          label={t('settings.appearance.width')}
          value={noteWidth}
          options={widthOptions}
          testIdPrefix="note-width"
          onChange={(width) => patchAppearance({ noteWidth: width })}
        />
        <p className="appearance-hint">{t('settings.appearance.widthHint')}</p>
      </div>
      <div className="appearance-group">
        <div className="appearance-font-field">
          <Select
            label={t('settings.appearance.fontFamily')}
            data-testid="note-font-family"
            value={fontFamily || NOTE_FONT_DEFAULT_CHOICE}
            options={fontOptions}
            style={{ fontFamily: noteFontFamilyCss(fontFamily) }}
            aria-describedby="note-font-family-hint"
            onValueChange={onFontFamilyChange}
            onOpenChange={(open) => {
              if (!open) return
              void listSystemFontFamilies()
                .then((next) => {
                  setFamilies((current) => (next.length >= current.length ? next : current))
                  setFontsReady(true)
                })
                .catch(() => setFontsReady(true))
            }}
          />
        </div>
        <p className="appearance-hint" id="note-font-family-hint">
          {t('settings.appearance.fontFamilyHint')}
        </p>
        {fontsReady && families.length === 0 ? (
          <p className="appearance-hint" data-testid="note-font-family-empty">
            {t('settings.appearance.fontFamilyEmpty')}
          </p>
        ) : null}
      </div>
      <div className="appearance-group">
        <div className="appearance-fontsize-field">
          <Input
            label={t('settings.appearance.fontSize')}
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
          {t('settings.appearance.fontHint', { min: NOTE_FONT_SIZE_MIN, max: NOTE_FONT_SIZE_MAX })}
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
  const { t } = useTranslation()
  return (
    <section className="appearance-section" data-testid="settings-section-appearance" aria-label={t('settings.appearance.region')}>
      <LanguageGroup />
      <ThemeGroup />
      {/* SettingsService is registered at app start; tests that mount the page
          without it still get the theme control. */}
      {has(SettingsService) ? <AppearancePrefsForm /> : null}
    </section>
  )
}
