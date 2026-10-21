// Embedding settings section (T7.2): endpoint/model/key/dim, connection probe,
// and the degraded-search status banner. State and persistence live in
// SettingsService; VaultService supplies the live searchDegraded flag.
//
// Key semantics (shared with save()): the draft starts as the stored mask so an
// untouched save keeps the sealed key; clearing the field saves an empty draft,
// which clears the key; typing anything else replaces it. An empty or illegal
// dim is not an error — it means dim 0, which turns the vector index off.

import { observer, useService } from '@rabjs/react'
import { CircleAlert, CircleCheck, LoaderCircle, TriangleAlert } from 'lucide-react'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { t } from '../../../i18n'
import { SettingsService, type EmbeddingRuntime } from '../../../services/settings/settings.service'
import { VaultService } from '../../../services/vault/vault.service'
import { Button } from '../../primitives/button'
import { Mark } from '../../primitives/icon'
import { Input } from '../../primitives/input'
import './embedding.css'

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

/** Positive integer or null. Matches SettingsService's parsePositiveInt. */
export function parseEmbeddingDim(value: string): number | null {
  const trimmed = value.trim()
  if (!/^[1-9]\d*$/.test(trimmed)) return null
  const parsed = Number(trimmed)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return null
  return parsed
}

export function embeddingEndpointError(endpoint: string): string {
  const trimmed = endpoint.trim()
  if (!trimmed) return ''
  return isHttpUrl(trimmed) ? '' : t('settings.embedding.badEndpoint')
}

/** Why vector search is off, for the degraded banner. */
export function degradedReason(runtime: EmbeddingRuntime): string {
  if (!runtime.intended) return t('settings.embedding.notConfigured')
  if (!runtime.active) return t('settings.embedding.keyMissing')
  return t('settings.embedding.unavailable')
}

function embeddingTestText(testResult: string): string {
  if (testResult === 'ok') return t('common.connectionOk')
  if (testResult === 'dim') return t('settings.embedding.dim')
  if (testResult.startsWith('dim:')) {
    const [, expected = '', actual = ''] = testResult.split(':')
    return t('settings.embedding.dimDetail', { expected, actual })
  }
  return testResult
}

export const EmbeddingSection = observer(function EmbeddingSection() {
  const { t } = useTranslation()
  const settings = useService(SettingsService)
  const vault = useService(VaultService)
  const embedding = settings.form.embedding
  const dim = parseEmbeddingDim(settings.embeddingDimText)
  const endpointError = embeddingEndpointError(embedding.endpoint)
  // Endpoint/model filled but no usable dim: embedding is wanted but off.
  const dimOff = dim === null && (embedding.endpoint.trim() !== '' || embedding.model.trim() !== '')
  const testing = settings.$model.testEmbedding.loading
  const saving = settings.$model.save.loading
  const testResult = settings.embeddingTestResult
  const testOk = testResult === 'ok'
  const testDimMismatch = testResult === 'dim' || testResult.startsWith('dim:')

  // Echo the stored mask into the draft so an untouched save keeps the key
  // (an empty draft would clear it). Refires only when the mask itself changes
  // (load/save), never while the user edits the field.
  const keyMask = embedding.keyMask
  useEffect(() => {
    if (keyMask && settings.embeddingKey === '') settings.embeddingKey = keyMask
  }, [keyMask, settings])

  return (
    <div className="settings-embedding" data-testid="settings-section-embedding">
      {vault.searchDegraded ? (
        <div className="settings-embedding-degraded" role="status" data-testid="embedding-degraded">
          <Mark icon={CircleAlert} size={16} />
          <span>{degradedReason(settings.embeddingRuntime())}</span>
        </div>
      ) : null}
      <div className="settings-embedding-field">
        <Input
          label={t('settings.embedding.endpoint')}
          className="settings-embedding-input"
          data-testid="embedding-endpoint"
          value={embedding.endpoint}
          placeholder="https://api.openai.com/v1"
          aria-invalid={Boolean(endpointError)}
          aria-errormessage={endpointError ? 'embedding-error-endpoint' : undefined}
          onChange={(event) => {
            settings.embeddingTestResult = ''
            settings.patchEmbedding({ endpoint: event.target.value })
          }}
        />
        {endpointError ? <span className="settings-embedding-error" id="embedding-error-endpoint" role="alert" data-testid="embedding-error-endpoint">{endpointError}</span> : null}
      </div>
      <div className="settings-embedding-field">
        <Input
          label={t('settings.embedding.model')}
          className="settings-embedding-input"
          data-testid="embedding-model"
          value={embedding.model}
          placeholder="text-embedding-3-small"
          onChange={(event) => {
            settings.embeddingTestResult = ''
            settings.patchEmbedding({ model: event.target.value })
          }}
        />
      </div>
      <div className="settings-embedding-field">
        <Input
          label={t('settings.embedding.apiKey')}
          className="settings-embedding-input"
          data-testid="embedding-key"
          type="password"
          value={settings.embeddingKey}
          placeholder={embedding.keyMask || t('settings.embedding.apiKeyPlaceholder')}
          aria-describedby="embedding-key-meta"
          onChange={(event) => {
            settings.embeddingTestResult = ''
            settings.embeddingKey = event.target.value
          }}
        />
        <span className="settings-embedding-meta" id="embedding-key-meta">
          {embedding.keyMask
            ? t('settings.embedding.keyKept', { mask: embedding.keyMask })
            : t('settings.embedding.keySealed')}
        </span>
      </div>
      <div className="settings-embedding-field">
        <Input
          label={t('settings.embedding.dimensions')}
          className="settings-embedding-input"
          data-testid="embedding-dim"
          inputMode="numeric"
          value={settings.embeddingDimText}
          placeholder="1536"
          aria-invalid={dimOff}
          aria-describedby={dimOff ? 'embedding-dim-note' : undefined}
          onChange={(event) => {
            settings.embeddingTestResult = ''
            settings.setEmbeddingDim(event.target.value)
          }}
        />
        {dimOff ? (
          <span className="settings-embedding-note" id="embedding-dim-note" data-testid="embedding-dim-note">
            {t('settings.embedding.dimOff')}
          </span>
        ) : null}
      </div>
      <div className="settings-embedding-actions">
        <Button
          tone="secondary"
          size="sm"
          data-testid="embedding-test"
          disabled={testing || Boolean(endpointError) || dim === null}
          icon={testing ? <span className="settings-embedding-spin"><Mark icon={LoaderCircle} size={14} /></span> : undefined}
          onClick={() => {
            void settings.testEmbedding()
          }}
        >
          {testing ? t('common.testing') : t('common.testConnection')}
        </Button>
        {testResult ? (
          <p
            className={testOk ? 'settings-embedding-test-ok' : testDimMismatch ? 'settings-embedding-test-warn' : 'settings-embedding-test-err'}
            data-testid="embedding-test-result"
            role="status"
          >
            <Mark icon={testOk ? CircleCheck : testDimMismatch ? TriangleAlert : CircleAlert} size={14} />
            <span>{embeddingTestText(testResult)}</span>
          </p>
        ) : null}
      </div>
      <div className="settings-embedding-actions settings-embedding-save">
        <Button
          tone="primary"
          size="lg"
          data-testid="settings-embedding-save"
          disabled={saving || Boolean(endpointError)}
          icon={saving ? <span className="settings-embedding-spin"><Mark icon={LoaderCircle} size={14} /></span> : undefined}
          onClick={() => {
            void settings.save()
          }}
        >
          {saving ? t('common.saving') : t('common.save')}
        </Button>
        {settings.notice ? <p className="settings-embedding-error" data-testid="settings-embedding-notice" role="alert">{settings.notice}</p> : null}
      </div>
    </div>
  )
})
