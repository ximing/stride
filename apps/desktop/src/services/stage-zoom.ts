// Per-vault stage zoom (T7.3). VaultService pushes the vault's zoom here on
// open and on change; styles.css applies it to the editor column via
// `zoom: var(--sd-stage-zoom, 1)` on .stage. CSS zoom (not transform scale)
// keeps layout math and caret coordinates intact; engines without zoom
// support simply render 1x.

import { VAULT_ZOOM_DEFAULT } from '../../../../packages/core/src/vault-config'

export const STAGE_ZOOM_VAR = '--sd-stage-zoom'

/** Set (or clear, for the default) the stage zoom variable on <html>. Idempotent. */
export function applyStageZoom(zoom: number): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  if (!Number.isFinite(zoom) || zoom === VAULT_ZOOM_DEFAULT) root.style.removeProperty(STAGE_ZOOM_VAR)
  else root.style.setProperty(STAGE_ZOOM_VAR, String(zoom))
}
