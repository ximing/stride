// AI settings section (T7.2): multi-provider LLM config management. State and
// persistence live in SettingsService; this file adds the list editor, inline
// validation, and the connection probe UI. Key drafts follow the shared mask
// semantics: untouched (no draft) keeps the sealed key, an empty draft clears
// it, a mask-shaped draft keeps it, anything else replaces it.

import { Plus } from '@phosphor-icons/react/Plus'
import { SpinnerGap } from '@phosphor-icons/react/SpinnerGap'
import { Star } from '@phosphor-icons/react/Star'
import { Trash } from '@phosphor-icons/react/Trash'
import { WarningCircle } from '@phosphor-icons/react/WarningCircle'
import { observer, useService } from '@rabjs/react'
import { catalogBaseUrl, catalogModelSuggestions, LLM_PROVIDERS, llmProviderInfo, type PublicLlmConfig } from '@stride/core'
import { SettingsService } from '../../../services/panels.service'
import { Mark } from '../../icon'
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
                    <Mark icon={WarningCircle} size={14} />
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
        <button type="button" className="settings-ai-btn" data-testid="llm-add" onClick={() => settings.addLlmConfig()}>
          <Mark icon={Plus} size={14} />
          Add provider
        </button>
        <button
          type="button"
          className="settings-ai-btn"
          data-testid="llm-delete"
          disabled={!selected}
          onClick={() => selected && settings.removeLlmConfig(selected.id)}
        >
          <Mark icon={Trash} size={14} />
          Delete
        </button>
        <button
          type="button"
          className="settings-ai-btn"
          data-testid="llm-default"
          disabled={!selected || selected.isDefault}
          onClick={() => selected && settings.setDefaultLlmConfig(selected.id)}
        >
          <Mark icon={Star} size={14} />
          Set as default
        </button>
      </div>
      {selected ? (
        <div className="settings-ai-form">
          <label className="settings-ai-field">
            <span>Name</span>
            <input
              className="settings-ai-input"
              data-testid="llm-name"
              value={selected.name}
              aria-invalid={Boolean(selectedErrors.name)}
              onChange={(event) => settings.patchLlmConfig({ name: event.target.value })}
            />
            {selectedErrors.name ? <span className="settings-ai-error" data-testid="llm-error-name">{selectedErrors.name}</span> : null}
          </label>
          <label className="settings-ai-field">
            <span>Provider</span>
            <select
              className="settings-ai-input"
              data-testid="llm-provider"
              value={selected.provider}
              aria-invalid={Boolean(selectedErrors.provider)}
              onChange={(event) => settings.patchLlmConfig({ provider: event.target.value })}
            >
              {LLM_PROVIDERS.map((provider) => (
                <option key={provider.id} value={provider.id}>{provider.label}</option>
              ))}
            </select>
            {selectedErrors.provider ? <span className="settings-ai-error" data-testid="llm-error-provider">{selectedErrors.provider}</span> : null}
          </label>
          <label className="settings-ai-field">
            <span>Model</span>
            <input
              className="settings-ai-input"
              data-testid="llm-model"
              value={selected.model}
              list="settings-ai-model-suggestions"
              aria-invalid={Boolean(selectedErrors.model)}
              onChange={(event) => settings.patchLlmConfig({ model: event.target.value })}
            />
            <datalist id="settings-ai-model-suggestions">
              {catalogModelSuggestions(selected.provider).map((model) => (
                <option key={model} value={model} />
              ))}
            </datalist>
            {selectedErrors.model ? <span className="settings-ai-error" data-testid="llm-error-model">{selectedErrors.model}</span> : null}
          </label>
          <label className="settings-ai-field">
            <span>Base URL</span>
            <input
              className="settings-ai-input"
              data-testid="llm-base-url"
              value={selected.baseUrl}
              placeholder={catalogBaseUrl(selected.provider) || 'https://…'}
              aria-invalid={Boolean(selectedErrors.baseUrl)}
              onChange={(event) => settings.patchLlmConfig({ baseUrl: event.target.value })}
            />
            {selectedErrors.baseUrl ? <span className="settings-ai-error" data-testid="llm-error-base-url">{selectedErrors.baseUrl}</span> : null}
          </label>
          <label className="settings-ai-field">
            <span>API key</span>
            <input
              className="settings-ai-input"
              data-testid="llm-key"
              type="password"
              value={settings.llmKeyDrafts[selected.id] ?? ''}
              placeholder={selected.keyMask || 'API key'}
              onChange={(event) => {
                settings.llmKeyDrafts = { ...settings.llmKeyDrafts, [selected.id]: event.target.value }
              }}
            />
            <span className="settings-ai-meta">
              {selected.keyMask
                ? `Stored key ${selected.keyMask} — kept while the field stays untouched; enter a new key to replace it.`
                : 'Keys are sealed before they are stored and never written in plaintext.'}
            </span>
          </label>
          <div className="settings-ai-actions">
            <button
              type="button"
              className="settings-ai-btn"
              data-testid="llm-test"
              disabled={testing || hasLlmErrors(selectedErrors)}
              onClick={() => {
                settings.llmTestResult = ''
                void settings.testSelectedLlm()
              }}
            >
              {testing ? <span className="settings-ai-spin"><Mark icon={SpinnerGap} size={14} /></span> : null}
              {testing ? 'Testing…' : 'Test connection'}
            </button>
            {settings.llmTestResult ? (
              <p
                className={testOk ? 'settings-ai-test-ok' : 'settings-ai-test-err'}
                data-testid="llm-test-result"
                role="status"
              >
                {testOk ? 'Connection successful.' : settings.llmTestResult}
              </p>
            ) : null}
          </div>
        </div>
      ) : null}
      <div className="settings-ai-save">
        <button
          type="button"
          className="settings-ai-btn settings-ai-btn-primary"
          data-testid="settings-ai-save"
          disabled={saving || invalidCount > 0}
          onClick={() => {
            void settings.save()
          }}
        >
          {saving ? <span className="settings-ai-spin"><Mark icon={SpinnerGap} size={14} /></span> : null}
          {saving ? 'Saving…' : 'Save'}
        </button>
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
