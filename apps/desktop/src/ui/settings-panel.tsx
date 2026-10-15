import { Desktop, Moon, Sun } from '@phosphor-icons/react'
import { observer, useService } from '@rabjs/react'
import { LLM_PROVIDERS, catalogBaseUrl, catalogModelSuggestions } from '@stride/core'
import { SettingsService, UpdateService } from '../services/panels.service'
import { ThemeService } from '../services/theme.service'
import { THEME_MODES, type ThemeMode } from '../services/theme'
import { Mark } from './icon'

const THEME_ICONS: Record<ThemeMode, typeof Sun> = { light: Sun, dark: Moon, system: Desktop }
const THEME_LABELS: Record<ThemeMode, string> = { light: 'Light', dark: 'Dark', system: 'System' }

export const SettingsPanel = observer(function SettingsPanel() {
  const settings = useService(SettingsService)
  const updates = useService(UpdateService)
  const theme = useService(ThemeService)
  const selected = settings.form.llmConfigs.find((config) => config.id === settings.selectedLlmId)
  return (
    <div>
      <h2>Settings</h2>
      <div className="field">
        <span>Theme</span>
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
      </div>
      <label className="field"><span>Embedding endpoint</span>
        <input value={settings.form.embedding.endpoint} onChange={(event) => settings.patchEmbedding({ endpoint: event.target.value })} />
      </label>
      <label className="field"><span>Embedding model</span>
        <input value={settings.form.embedding.model} onChange={(event) => settings.patchEmbedding({ model: event.target.value })} />
      </label>
      <label className="field"><span>Embedding dim</span>
        <input
          data-testid="embedding-dim"
          inputMode="numeric"
          value={settings.embeddingDimText}
          onChange={(event) => settings.setEmbeddingDim(event.target.value)}
        />
      </label>
      <label className="field"><span>Embedding key</span>
        <input
          type="password"
          value={settings.embeddingKey}
          placeholder={settings.form.embedding.keyMask}
          onChange={(event) => { settings.embeddingKey = event.target.value }}
        />
        {settings.form.embedding.keyMask ? <span className="meta">{settings.form.embedding.keyMask}</span> : null}
      </label>
      <div className="editor-tools">
        <button type="button" data-testid="embedding-test" onClick={() => { void settings.testEmbedding() }}>Test connection</button>
      </div>
      <p className="meta" data-testid="embedding-test-result">{settings.embeddingTestResult}</p>
      <label className="field"><span>LLM config</span>
        <select
          data-testid="llm-config"
          value={settings.selectedLlmId}
          onChange={(event) => { settings.selectedLlmId = event.target.value }}
        >
          {settings.form.llmConfigs.map((config) => (
            <option key={config.id} value={config.id}>{config.name || config.id}</option>
          ))}
        </select>
      </label>
      <div className="editor-tools">
        <button type="button" data-testid="llm-add" onClick={() => settings.addLlmConfig()}>Add</button>
        <button type="button" data-testid="llm-delete" onClick={() => settings.removeLlmConfig()}>Delete</button>
        <button type="button" data-testid="llm-default" onClick={() => settings.setDefaultLlmConfig()}>Default</button>
      </div>
      {selected && (
        <>
          <label className="field"><span>Name</span>
            <input data-testid="llm-name" value={selected.name} onChange={(event) => settings.patchLlmConfig({ name: event.target.value })} />
          </label>
          <label className="field"><span>Provider</span>
            <select data-testid="llm-provider" value={selected.provider} onChange={(event) => settings.patchLlmConfig({ provider: event.target.value })}>
              {LLM_PROVIDERS.map((provider) => (
                <option key={provider.id} value={provider.id}>{provider.label}</option>
              ))}
            </select>
          </label>
          <label className="field"><span>Model</span>
            <input
              data-testid="llm-model"
              value={selected.model}
              list="llm-model-suggestions"
              onChange={(event) => settings.patchLlmConfig({ model: event.target.value })}
            />
            <datalist id="llm-model-suggestions">
              {catalogModelSuggestions(selected.provider).map((model) => (
                <option key={model} value={model} />
              ))}
            </datalist>
          </label>
          <label className="field"><span>Base URL</span>
            <input
              data-testid="llm-base-url"
              value={selected.baseUrl}
              placeholder={catalogBaseUrl(selected.provider)}
              onChange={(event) => settings.patchLlmConfig({ baseUrl: event.target.value })}
            />
          </label>
          <label className="field"><span>API key</span>
            <input
              data-testid="llm-key"
              type="password"
              value={settings.llmKeyDrafts[selected.id] ?? ''}
              placeholder={selected.keyMask}
              onChange={(event) => { settings.llmKeyDrafts = { ...settings.llmKeyDrafts, [selected.id]: event.target.value } }}
            />
          </label>
          <div className="editor-tools">
            <button type="button" data-testid="llm-test" onClick={() => { void settings.testSelectedLlm() }}>Test connection</button>
          </div>
          <p className="meta" data-testid="llm-test-result">{settings.llmTestResult}</p>
        </>
      )}
      <label className="field"><span>GitHub releases URL</span>
        <input value={settings.form.releasesUrl} onChange={(event) => settings.setReleasesUrl(event.target.value)} />
      </label>
      <label className="field"><span>Git enabled</span>
        <input
          type="checkbox"
          data-testid="git-enabled"
          checked={settings.form.gitEnabled}
          onChange={(event) => settings.setGitEnabled(event.target.checked)}
        />
      </label>
      <label className="field"><span>Auto sync (minutes)</span>
        <input
          type="number"
          min={0}
          data-testid="auto-sync-minutes"
          value={settings.form.autoSyncMinutes}
          onChange={(event) => settings.setAutoSyncMinutes(Number(event.target.value))}
        />
      </label>
      <label className="field"><span>Auto Git</span>
        <input
          type="checkbox"
          data-testid="auto-git-enabled"
          checked={settings.form.autoGitEnabled}
          onChange={(event) => settings.setAutoGitEnabled(event.target.checked)}
        />
      </label>
      <label className="field"><span>Auto Git idle (seconds)</span>
        <input
          type="number"
          min={0}
          data-testid="auto-git-idle"
          value={settings.form.autoGitIdleSeconds}
          onChange={(event) => settings.setAutoGitIdleSeconds(Number(event.target.value))}
        />
      </label>
      <label className="field"><span>Auto Git blur (seconds)</span>
        <input
          type="number"
          min={0}
          data-testid="auto-git-blur"
          value={settings.form.autoGitBlurSeconds}
          onChange={(event) => settings.setAutoGitBlurSeconds(Number(event.target.value))}
        />
      </label>
      <div className="editor-tools">
        <button type="button" data-testid="settings-save" onClick={() => settings.save()}>Save settings</button>
        <button type="button" onClick={() => updates.check()}>Check for updates</button>
      </div>
      {settings.notice && <p className="meta">{settings.notice}</p>}
    </div>
  )
})
