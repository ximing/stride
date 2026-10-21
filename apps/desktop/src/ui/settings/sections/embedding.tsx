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
import { SettingsService, type EmbeddingRuntime } from '../../../services/panels.service'
import { VaultService } from '../../../services/vault.service'
import { Button } from '../../button'
import { Mark } from '../../icon'
import { Input } from '../../input'
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
  return isHttpUrl(trimmed) ? '' : 'Endpoint must be a valid http:// or https:// URL'
}

/** Why vector search is off, for the degraded banner. */
export function degradedReason(runtime: EmbeddingRuntime): string {
  if (!runtime.intended) {
    return 'Vector search is not configured — set the endpoint, model, and a positive dim. Search falls back to text (BM25).'
  }
  if (!runtime.active) {
    return 'Vector search is inactive because the API key is missing. Search falls back to text (BM25).'
  }
  return 'Vector search is temporarily unavailable — the dim changed and the index needs a rebuild, or embedding requests are failing. Search falls back to text (BM25).'
}

export const EmbeddingSection = observer(function EmbeddingSection() {
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
  const testOk = testResult === '连接成功'
  const testDimMismatch = !testOk && testResult.startsWith('维度不符')

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
          label="Endpoint"
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
          label="Model"
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
          label="API key"
          className="settings-embedding-input"
          data-testid="embedding-key"
          type="password"
          value={settings.embeddingKey}
          placeholder={embedding.keyMask || 'API key'}
          aria-describedby="embedding-key-meta"
          onChange={(event) => {
            settings.embeddingTestResult = ''
            settings.embeddingKey = event.target.value
          }}
        />
        <span className="settings-embedding-meta" id="embedding-key-meta">
          {embedding.keyMask
            ? `Stored key ${embedding.keyMask} — kept while the mask stays in the field; clear the field to remove the key.`
            : 'Keys are sealed before they are stored and never written in plaintext.'}
        </span>
      </div>
      <div className="settings-embedding-field">
        <Input
          label="Dimensions"
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
            Dim is empty or not a positive integer, so the vector index stays off (dim = 0) and search uses text only.
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
          {testing ? 'Testing…' : 'Test connection'}
        </Button>
        {testResult ? (
          <p
            className={testOk ? 'settings-embedding-test-ok' : testDimMismatch ? 'settings-embedding-test-warn' : 'settings-embedding-test-err'}
            data-testid="embedding-test-result"
            role="status"
          >
            <Mark icon={testOk ? CircleCheck : testDimMismatch ? TriangleAlert : CircleAlert} size={14} />
            <span>{testOk ? 'Connection successful.' : testDimMismatch ? `Dimension mismatch: ${testResult.replace(/^维度不符:?\s*/, '')}` : testResult}</span>
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
          {saving ? 'Saving…' : 'Save'}
        </Button>
        {settings.notice ? <p className="settings-embedding-error" data-testid="settings-embedding-notice" role="alert">{settings.notice}</p> : null}
      </div>
    </div>
  )
})
