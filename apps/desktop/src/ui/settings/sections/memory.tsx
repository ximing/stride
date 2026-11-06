// Memory settings (design §7): master switch for long-term memory plus the
// optional dedicated model for background distillation/curation. '' follows
// the chat default model. State and persistence live in SettingsService.
// The entry list is a read-only view over the two-scope memory index
// (project + global); editing stays with the agent's memory tools.

import { has, observer, useService } from '@rabjs/react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { MemoryIndexEntry, MemoryScope } from '@stride/core'
import { ChatService } from '../../../services/chat/chat.service'
import { SettingsService } from '../../../services/settings/settings.service'
import { VaultService } from '../../../services/vault/vault.service'
import { Select } from '../../primitives/select'
import './memory.css'

function relativeTime(iso: string, translate: (key: string, options?: Record<string, unknown>) => string): string {
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return ''
  const diff = Date.now() - ms
  if (diff < 60_000) return translate('chat.justNow')
  if (diff < 3_600_000) return translate('chat.minutesAgo', { count: Math.floor(diff / 60_000) })
  if (diff < 86_400_000) return translate('chat.hoursAgo', { count: Math.floor(diff / 3_600_000) })
  if (diff < 7 * 86_400_000) return translate('chat.daysAgo', { count: Math.floor(diff / 86_400_000) })
  return new Date(ms).toLocaleDateString()
}

interface MemoryLists {
  project: MemoryIndexEntry[]
  global: MemoryIndexEntry[]
}

const MemoryEntryRow = observer(function MemoryEntryRow({
  scope,
  entry,
}: {
  scope: MemoryScope
  entry: MemoryIndexEntry
}) {
  const { t } = useTranslation()
  const chat = useService(ChatService)
  const [open, setOpen] = useState(false)
  const [content, setContent] = useState<string | null>(null)
  useEffect(() => {
    if (!open || content !== null) return
    let stale = false
    void chat
      .readMemory(scope, entry.id)
      .then((detail) => {
        if (!stale) setContent(detail?.content ?? '')
      })
      .catch(() => {
        if (!stale) setContent('')
      })
    return () => {
      stale = true
    }
  }, [chat, scope, entry.id, open, content])
  return (
    <li className="memory-entry" data-testid="memory-entry" data-scope={scope}>
      <button
        type="button"
        className="memory-entry-summary"
        aria-expanded={open}
        onClick={() => setOpen((next) => !next)}
      >
        <span className="memory-entry-kind" data-testid="memory-entry-kind">
          {t(`settings.memory.kind.${entry.kind}`)}
        </span>
        <span className="memory-entry-title">{entry.title}</span>
        <span className="memory-entry-time">{relativeTime(entry.updatedAt, t)}</span>
      </button>
      <p className="memory-entry-text">{entry.summary}</p>
      {open ? (
        <p className="memory-entry-content" data-testid="memory-entry-content">
          {content ?? '…'}
        </p>
      ) : null}
    </li>
  )
})

const MemoryList = observer(function MemoryList() {
  const { t } = useTranslation()
  const chat = useService(ChatService)
  const vault = useService(VaultService)
  const [lists, setLists] = useState<MemoryLists | null>(null)
  const [failed, setFailed] = useState(false)
  const busy = chat.memoryBusy
  const vaultId = vault.activeVaultId
  useEffect(() => {
    let stale = false
    setFailed(false)
    void chat
      .listMemories()
      .then((next) => {
        if (!stale) setLists(next)
      })
      .catch(() => {
        if (!stale) setFailed(true)
      })
    return () => {
      stale = true
    }
  }, [chat, busy, vaultId])
  const groups: { scope: MemoryScope; label: string; entries: MemoryIndexEntry[] }[] = [
    { scope: 'project', label: vault.currentVaultLabel || t('settings.memory.projectScope'), entries: lists?.project ?? [] },
    { scope: 'global', label: t('settings.memory.globalScope'), entries: lists?.global ?? [] },
  ]
  return (
    <div className="memory-entries" data-testid="memory-list">
      <h3 className="memory-entries-title">{t('settings.memory.entries')}</h3>
      {failed ? <p className="error">{t('settings.memory.entriesLoadFailed')}</p> : null}
      {!failed && lists && lists.project.length + lists.global.length === 0 ? (
        <p className="memory-hint" data-testid="memory-empty">
          {t('settings.memory.entriesEmpty')}
        </p>
      ) : null}
      {groups.map((group) =>
        group.entries.length === 0 ? null : (
          <div className="memory-entries-group" data-testid={`memory-group-${group.scope}`} key={group.scope}>
            <h4 className="memory-entries-scope">{group.label}</h4>
            <ul className="memory-entries-list">
              {group.entries.map((entry) => (
                <MemoryEntryRow entry={entry} key={entry.id} scope={group.scope} />
              ))}
            </ul>
          </div>
        ),
      )}
    </div>
  )
})


const MemoryControls = observer(function MemoryControls() {
  const { t } = useTranslation()
  const settings = useService(SettingsService)
  const agent = settings.form.agent
  const enabled = agent?.memoryEnabled !== false
  const modelId = agent?.memoryModelId ?? ''
  // Radix Select rejects empty-string item values; '' maps to a sentinel.
  const FOLLOW_CHAT = '__follow_chat__'
  return (
    <div className="memory-group">
      <label className="memory-toggle settings-choice">
        <input
          className="settings-choice-control"
          type="checkbox"
          data-testid="memory-enabled"
          checked={enabled}
          onChange={(event) => {
            settings.form = {
              ...settings.form,
              agent: { ...settings.form.agent, memoryEnabled: event.target.checked },
            }
            void settings.save()
          }}
        />
        <span>{t('settings.memory.enable')}</span>
      </label>
      <p className="memory-hint">{t('settings.memory.enableHint')}</p>
      <div className="memory-field">
        <Select
          label={t('settings.memory.model')}
          className="memory-select"
          data-testid="memory-model"
          disabled={!enabled}
          value={modelId || FOLLOW_CHAT}
          options={[
            { value: FOLLOW_CHAT, label: t('settings.memory.followChat'), testId: 'memory-model-default' },
            ...settings.form.llmConfigs.map((config) => ({
              value: config.id,
              label: config.name || config.model || config.id,
              testId: `memory-model-${config.id}`,
            })),
          ]}
          onValueChange={(id) => {
            settings.form = {
              ...settings.form,
              agent: { ...settings.form.agent, memoryModelId: id === FOLLOW_CHAT ? '' : id },
            }
            void settings.save()
          }}
        />
      </div>
      <p className="memory-hint">{t('settings.memory.modelHint')}</p>
      {settings.notice ? (
        <p className="error" role="alert" data-testid="memory-notice">
          {settings.notice}
        </p>
      ) : null}
    </div>
  )
})

export function MemorySection() {
  const { t } = useTranslation()
  return (
    <section className="memory-section" data-testid="settings-section-memory" aria-label={t('settings.memory.region')}>
      {has(SettingsService) ? <MemoryControls /> : null}
      {has(ChatService) ? <MemoryList /> : null}
    </section>
  )
}
