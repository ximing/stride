// AI settings section (T7.2): multi-provider LLM config management. State and
// persistence live in SettingsService; this file adds the list editor, inline
// validation, and the connection probe UI. Key drafts follow the shared mask
// semantics: untouched (no draft) keeps the sealed key, an empty draft clears
// it, a mask-shaped draft keeps it, anything else replaces it.

import { observer, useService } from '@rabjs/react'
import { catalogBaseUrl, catalogModelSuggestions, LLM_PROVIDERS, llmProviderInfo, type PublicLlmConfig } from '@stride/core'
import { CircleAlert, CircleCheck, LoaderCircle, Plus, Star, Trash2 } from 'lucide-react'
import { SettingsService } from '../../../services/panels.service'
import { Button } from '../../button'
import { Mark } from '../../icon'
import { Input } from '../../input'
import { Select } from '../../select'
import './ai.css'

export interface LlmFieldErrors {
  name?: string
  provider?: string
  model?: string
  baseUrl?: string
}

export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

/** Inline validation for one config. An empty base URL falls back to the
 *  provider catalog default, so it is only required when the catalog has none
 *  (the custom provider). */
export function llmConfigErrors(config: PublicLlmConfig): LlmFieldErrors {
  const errors: LlmFieldErrors = {}
  if (!config.name.trim()) errors.name = 'Name is required'
  if (!config.provider.trim()) errors.provider = 'Provider is required'
  if (!config.model.trim()) errors.model = 'Model is required'
  const baseUrl = config.baseUrl.trim()
  if (baseUrl) {
    if (!isHttpUrl(baseUrl)) errors.baseUrl = 'Base URL must be a valid http:// or https:// URL'
  } else if (!catalogBaseUrl(config.provider)) {
    errors.baseUrl = 'Base URL is required for this provider'
  }
  return errors
}

export function hasLlmErrors(errors: LlmFieldErrors): boolean {
  return Object.values(errors).some(Boolean)
}

export const AiSection = observer(function AiSection() {
  const settings = useService(SettingsService)
  const configs = settings.form.llmConfigs
  const selected = configs.find((config) => config.id === settings.selectedLlmId)
  const errorsById = new Map(configs.map((config) => [config.id, llmConfigErrors(config)]))
  const invalidCount = configs.filter((config) => hasLlmErrors(errorsById.get(config.id) ?? {})).length
  const selectedErrors = selected ? errorsById.get(selected.id) ?? {} : {}
  const testing = settings.$model.testSelectedLlm.loading
  const saving = settings.$model.save.loading
  const testOk = settings.llmTestResult === '连接成功'

  return (
    <div className="settings-ai" data-testid="settings-section-ai">
      {configs.length === 0 ? (
        <p className="settings-ai-empty" data-testid="llm-empty">
          No model providers yet. Add one to enable the agent and commit message suggestions.
        </p>
      ) : (
        <div className="settings-ai-list" role="listbox" aria-label="LLM configurations">
          {configs.map((config) => {
            const invalid = hasLlmErrors(errorsById.get(config.id) ?? {})
            return (
              <button
                key={config.id}
                type="button"
                role="option"
                aria-selected={config.id === settings.selectedLlmId}
                className="settings-ai-row"
                data-testid={`llm-row-${config.id}`}
                onClick={() => settings.selectLlmConfig(config.id)}
              >
                <span className="settings-ai-row-name">{config.name || config.id}</span>
                <span className="settings-ai-row-provider">{llmProviderInfo(config.provider)?.label ?? config.provider}</span>
                {invalid ? (
                  <span className="settings-ai-row-warning" title="This configuration has errors">
                    <Mark icon={CircleAlert} size={14} />
                  </span>
                ) : null}
                {config.isDefault ? (
                  <span className="settings-ai-row-default" title="Default">
                    <Mark icon={Star} size={14} />
                    Default
                  </span>
                ) : null}
              </button>
            )
          })}
        </div>
      )}
      <div className="settings-ai-actions">
        <Button
          tone="secondary"
          size="sm"
          data-testid="llm-add"
          icon={<Mark icon={Plus} size={14} />}
          onClick={() => settings.addLlmConfig()}
        >
          Add provider
        </Button>
        <Button
          tone="danger"
          size="sm"
          data-testid="llm-delete"
          disabled={!selected}
          icon={<Mark icon={Trash2} size={14} />}
          onClick={() => selected && settings.removeLlmConfig(selected.id)}
        >
          Delete
        </Button>
        <Button
          tone="quiet"
          size="sm"
          data-testid="llm-default"
          disabled={!selected || selected.isDefault}
          icon={<Mark icon={Star} size={14} />}
          onClick={() => selected && settings.setDefaultLlmConfig(selected.id)}
        >
          Set as default
        </Button>
      </div>
      {selected ? (
        <div className="settings-ai-form">
          <div className="settings-ai-field">
            <Input
              label="Name"
              className="settings-ai-input"
              data-testid="llm-name"
              value={selected.name}
              aria-invalid={Boolean(selectedErrors.name)}
              aria-errormessage={selectedErrors.name ? 'llm-error-name' : undefined}
              onChange={(event) => settings.patchLlmConfig({ name: event.target.value })}
            />
            {selectedErrors.name ? <span className="settings-ai-error" id="llm-error-name" data-testid="llm-error-name">{selectedErrors.name}</span> : null}
          </div>
          <div className="settings-ai-field">
            <Select
              label="Provider"
              className="settings-ai-input"
              data-testid="llm-provider"
              value={selected.provider}
              aria-invalid={Boolean(selectedErrors.provider)}
              aria-errormessage={selectedErrors.provider ? 'llm-error-provider' : undefined}
              options={LLM_PROVIDERS.map((provider) => ({ value: provider.id, label: provider.label }))}
              onValueChange={(provider) => settings.patchLlmConfig({ provider })}
            />
            {selectedErrors.provider ? <span className="settings-ai-error" id="llm-error-provider" data-testid="llm-error-provider">{selectedErrors.provider}</span> : null}
          </div>
          <div className="settings-ai-field">
            <Input
              label="Model"
              className="settings-ai-input"
              data-testid="llm-model"
              value={selected.model}
              list="settings-ai-model-suggestions"
              aria-invalid={Boolean(selectedErrors.model)}
              aria-errormessage={selectedErrors.model ? 'llm-error-model' : undefined}
              onChange={(event) => settings.patchLlmConfig({ model: event.target.value })}
            />
            <datalist id="settings-ai-model-suggestions">
              {catalogModelSuggestions(selected.provider).map((model) => (
                <option key={model} value={model} />
              ))}
            </datalist>
            {selectedErrors.model ? <span className="settings-ai-error" id="llm-error-model" data-testid="llm-error-model">{selectedErrors.model}</span> : null}
          </div>
          <div className="settings-ai-field">
            <Input
              label="Base URL"
              className="settings-ai-input"
              data-testid="llm-base-url"
              value={selected.baseUrl}
              placeholder={catalogBaseUrl(selected.provider) || 'https://…'}
              aria-invalid={Boolean(selectedErrors.baseUrl)}
              aria-errormessage={selectedErrors.baseUrl ? 'llm-error-base-url' : undefined}
              onChange={(event) => settings.patchLlmConfig({ baseUrl: event.target.value })}
            />
            {selectedErrors.baseUrl ? <span className="settings-ai-error" id="llm-error-base-url" data-testid="llm-error-base-url">{selectedErrors.baseUrl}</span> : null}
          </div>
          <div className="settings-ai-field settings-ai-field-wide">
            <Input
              label="API key"
              className="settings-ai-input"
              data-testid="llm-key"
              type="password"
              value={settings.llmKeyDrafts[selected.id] ?? ''}
              placeholder={selected.keyMask || 'API key'}
              aria-describedby="llm-key-meta"
              onChange={(event) => {
                settings.llmKeyDrafts = { ...settings.llmKeyDrafts, [selected.id]: event.target.value }
              }}
            />
            <span className="settings-ai-meta" id="llm-key-meta">
              {selected.keyMask
                ? `Stored key ${selected.keyMask} — kept while the field stays untouched; enter a new key to replace it.`
                : 'Keys are sealed before they are stored and never written in plaintext.'}
            </span>
          </div>
          <div className="settings-ai-actions settings-ai-field-wide">
            <Button
              tone="secondary"
              size="sm"
              data-testid="llm-test"
              disabled={testing || hasLlmErrors(selectedErrors)}
              icon={testing ? <span className="settings-ai-spin"><Mark icon={LoaderCircle} size={14} /></span> : undefined}
              onClick={() => {
                settings.llmTestResult = ''
                void settings.testSelectedLlm()
              }}
            >
              {testing ? 'Testing…' : 'Test connection'}
            </Button>
            {settings.llmTestResult ? (
              <p
                className={testOk ? 'settings-ai-test-ok' : 'settings-ai-test-err'}
                data-testid="llm-test-result"
                role="status"
              >
                <Mark icon={testOk ? CircleCheck : CircleAlert} size={14} />
                <span>{testOk ? 'Connection successful.' : settings.llmTestResult}</span>
              </p>
            ) : null}
          </div>
        </div>
      ) : null}
      <div className="settings-ai-save">
        <Button
          tone="primary"
          size="lg"
          data-testid="settings-ai-save"
          disabled={saving || invalidCount > 0}
          icon={saving ? <span className="settings-ai-spin"><Mark icon={LoaderCircle} size={14} /></span> : undefined}
          onClick={() => {
            void settings.save()
          }}
        >
          {saving ? 'Saving…' : 'Save'}
        </Button>
        {invalidCount > 0 ? (
          <p className="settings-ai-error" data-testid="settings-ai-invalid-summary" role="alert">
            Fix the highlighted fields before saving ({invalidCount} of {configs.length} {configs.length === 1 ? 'configuration' : 'configurations'} invalid).
          </p>
        ) : null}
        {settings.notice ? <p className="settings-ai-error" data-testid="settings-ai-notice" role="alert">{settings.notice}</p> : null}
      </div>
    </div>
  )
})
