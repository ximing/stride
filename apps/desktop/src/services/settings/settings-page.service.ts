// Settings dialog state: open flag plus the active section. The dialog is a
// centered modal (not a route, not an editor tab), so its service is a global
// singleton registered in main.tsx. It joins the overlay cohort, so opening
// it closes quick open / search / palette and vice versa.

import { has, register, Service } from '@rabjs/react'
import { closeOtherOverlays } from '../platform/overlays'

export const SETTINGS_SECTION_IDS = [
  'appearance',
  'editor',
  'ai',
  'embedding',
  'git',
  'updates',
  'privacy',
  'shortcuts',
  'vault',
] as const

export type SettingsSectionId = (typeof SETTINGS_SECTION_IDS)[number]

export class SettingsPageService extends Service {
  open = false
  section: SettingsSectionId = 'appearance'

  show(section: SettingsSectionId = 'appearance') {
    closeOtherOverlays('settings', () => this.close())
    this.section = section
    this.open = true
  }

  close() {
    this.open = false
  }

  select(section: SettingsSectionId) {
    this.section = section
  }
}

// Tests mount the page without main.tsx, so the global service must exist on import.
if (!has(SettingsPageService)) register(SettingsPageService)
