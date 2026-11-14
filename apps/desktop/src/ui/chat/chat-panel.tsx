import { History, MessageCircle, Plus, Send, Square, Trash2, Wrench, X } from 'lucide-react'
import { normalizeAgentMaxTurns, type ChatSessionMeta, type PublicLlmConfig } from '@stride/core'
import { agentExecutableCommand } from '@stride/platform'
import { observer, useService } from '@rabjs/react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CHAT_HISTORY_LOAD_ERROR, CHAT_TURN_LIMIT_ERROR, ChatService } from '../../services/chat/chat.service'
import type { ChatToolCall } from '../../services/chat/chat-turn'
import { handleOverlayListKey, registerOverlayKeys } from '../../services/platform/overlay-keys'
import { SettingsService } from '../../services/settings/settings.service'
import { VaultService } from '../../services/vault/vault.service'
import { ChatMarkdown } from './chat-markdown'
import { Button, IconButton } from '../primitives/button'
import { EmptyState } from '../primitives/empty-state'
import { isAgentMode, isExternalAgentMode } from '@stride/core'
import { Mark } from '../primitives/icon'
import { Select } from '../primitives/select'

function chatErrorText(
  error: string,
  translate: (key: string, options?: Record<string, unknown>) => string,
  turns: number,
): string {
  if (error === 'Add a model provider, base URL, model, and key in Settings') return translate('chat.needProvider')
  if (error === 'external-agent-unavailable') return translate('chat.externalUnavailable')
  if (error === 'external-agent-missing') return translate('chat.externalMissing')
  if (error === 'external-agent-handshake') return translate('chat.externalHandshake')
  if (error === 'external-agent-aborted') return translate('chat.externalAborted')
  if (error === 'external-agent-stopped') return translate('chat.externalStopped')
  if (error === 'external-agent-stopped-resume') return translate('chat.externalStoppedResume')
  if (error === 'external-agent-failed') return translate('chat.externalFailed')
  if (error === 'external-agent-resume-failed') return translate('chat.externalResumeFailed')
  if (error === CHAT_TURN_LIMIT_ERROR) return translate('chat.turnLimit', { count: turns })
  if (error === CHAT_HISTORY_LOAD_ERROR) return translate('chat.historyLoadFailed')
  return error
}

function executableBaseName(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return cut >= 0 ? path.slice(cut + 1) : path
}

function relativeTime(
  iso: string,
  translate: (key: string, options?: Record<string, unknown>) => string,
): string {
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return ''
  const diff = Date.now() - ms
  if (diff < 60_000) return translate('chat.justNow')
  if (diff < 3_600_000) return translate('chat.minutesAgo', { count: Math.floor(diff / 60_000) })
  if (diff < 86_400_000) return translate('chat.hoursAgo', { count: Math.floor(diff / 3_600_000) })
  if (diff < 7 * 86_400_000) return translate('chat.daysAgo', { count: Math.floor(diff / 86_400_000) })
  return new Date(ms).toLocaleDateString()
}

function ChatTool({ tool }: { tool: ChatToolCall }) {
  const { t } = useTranslation()
  return (
    <details className={tool.isError ? 'chat-tool is-error' : 'chat-tool'} data-testid="chat-tool">
      <summary className="chat-tool-summary">
        <span className="chat-tool-name" data-testid="chat-tool-name">{tool.name}</span>
        {tool.pending ? <span className="chat-tool-status">{t('chat.running')}</span> : null}
        {tool.isError ? <span className="chat-tool-status">{t('chat.failed')}</span> : null}
        {typeof tool.durationMs === 'number' ? (
          <span className="chat-tool-duration" data-testid="chat-tool-duration">{t('chat.duration', { ms: tool.durationMs })}</span>
        ) : null}
      </summary>
      <div className="chat-tool-body">
        {tool.argsSummary ? <span className="chat-tool-args" data-testid="chat-tool-args">{tool.argsSummary}</span> : null}
        {tool.pending ? null : <span className="chat-tool-result" data-testid="chat-tool-result">{tool.resultSummary}</span>}
      </div>
    </details>
  )
}

/** One assistant message's tool calls collapse into a single summary row. */
function ChatTools({ tools }: { tools: ChatToolCall[] }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const failed = tools.filter((tool) => tool.isError).length
  const pending = tools.some((tool) => tool.pending)
  const className = [
    'chat-tools',
    failed > 0 ? 'is-error' : '',
    pending ? 'is-running' : '',
  ].filter(Boolean).join(' ')
  return (
    <div className={className}>
      <button
        type="button"
        className="chat-tools-summary"
        data-testid="chat-tools-summary"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className="chat-tools-icon"><Mark icon={Wrench} size={12} /></span>
        <span className="chat-tools-label">{t('chat.toolCalls', { count: tools.length })}</span>
        {failed > 0 ? <span className="chat-tools-failed" data-testid="chat-tools-failed">{t('chat.toolFailures', { count: failed })}</span> : null}
      </button>
      {open ? tools.map((tool) => <ChatTool key={tool.id} tool={tool} />) : null}
    </div>
  )
}

function modelOptionLabel(config: PublicLlmConfig): string {
  const name = config.name.trim()
  const model = config.model.trim()
  if (name && model && name !== model) return `${name} · ${model}`
  return model || name || config.provider || config.id
}

const ChatHistory = observer(function ChatHistory() {
  const { t } = useTranslation()
  const chat = useService(ChatService)
  const [selected, setSelected] = useState(0)

  useEffect(
    () =>
      registerOverlayKeys({
        id: 'chatHistory',
        layer: 'panel',
        isOpen: () => chat.historyOpen,
        onKeyDown: (event) => {
          if (!chat.historyOpen) return
          handleOverlayListKey(event, {
            move: (delta) => setSelected((current) => {
              const total = chat.metas.length
              if (total === 0) return 0
              return Math.min(Math.max(current + delta, 0), total - 1)
            }),
            confirm: () => {
              const meta = chat.metas[Math.min(selected, chat.metas.length - 1)]
              if (meta) void chat.openFromHistory(meta.id)
            },
            close: () => chat.closeHistory(),
          })
        },
      }),
    [chat, selected],
  )

  if (!chat.historyOpen) return null

  return (
    <div
      className="chat-history-overlay"
      data-testid="chat-history-overlay"
      role="dialog"
      aria-label={t('chat.historyTitle')}
    >
      <div className="chat-history-head">
        <h2 className="chat-history-title">{t('chat.historyTitle')}</h2>
        <IconButton
          icon={X}
          label={t('chat.close')}
          size="sm"
          iconSize={14}
          data-testid="chat-history-close"
          onClick={() => chat.closeHistory()}
        />
      </div>
      <div className="chat-history-list" data-testid="chat-history-list" role="listbox" aria-label={t('chat.historyTitle')}>
        {chat.metas.length === 0 ? (
          <EmptyState
            compact
            icon={History}
            title={t('chat.historyEmpty')}
            testId="chat-history-empty"
          />
        ) : (
          chat.metas.map((meta: ChatSessionMeta, index: number) => (
            <div
              key={meta.id}
              className="chat-history-item"
              data-testid="chat-history-item"
              role="option"
              aria-selected={index === selected}
            >
              <button
                type="button"
                className="chat-history-open"
                data-testid="chat-history-open"
                disabled={chat.running}
                onClick={() => void chat.openFromHistory(meta.id)}
              >
                <span className="chat-history-item-title">{meta.title || t('chat.new')}</span>
                <span className="chat-history-item-meta">
                  {relativeTime(meta.updatedAt, t)} · {t('chat.messagesCount', { count: meta.messageCount })}
                </span>
              </button>
              <IconButton
                icon={Trash2}
                label={t('chat.delete')}
                size="sm"
                iconSize={14}
                data-testid="chat-history-delete"
                disabled={chat.running && meta.id === chat.session.id}
                onClick={() => void chat.deleteSession(meta.id)}
              />
            </div>
          ))
        )}
      </div>
    </div>
  )
})

export const ChatPanel = observer(function ChatPanel() {
  const { t } = useTranslation()
  const chat = useService(ChatService)
  const settings = useService(SettingsService)
  const vault = useService(VaultService)
  const session = chat.session
  const models = settings.form.llmConfigs
  const modelId = chat.activeModelId
  const title = session.messages.length === 0 ? t('chat.new') : session.title
  const external = isExternalAgentMode(vault.agentMode)
  const externalOk = chat.externalAgentsAvailable
  const externalCommand = isExternalAgentMode(vault.agentMode)
    ? agentExecutableCommand(vault.agentMode, settings.form.agent?.executables?.[vault.agentMode])
    : ''
  const knownExec = chat.externalExec
    && chat.externalExec.mode === vault.agentMode
    && chat.externalExec.command === externalCommand
    ? chat.externalExec
    : null
  const externalExecLabel = !knownExec
    ? t('chat.externalExecChecking')
    : knownExec.found
      ? t('chat.externalExecFound', { name: executableBaseName(knownExec.resolved), path: knownExec.resolved })
      : t('chat.externalExecMissing')
  // A recalled session locked to another model keeps using it; say so.
  const lockedModel = !external && session.modelId && session.modelId !== modelId
    ? models.find((config) => config.id === session.modelId) ?? null
    : null

  useEffect(() => {
    void chat.ensureLoaded()
  }, [chat, vault.activeVaultId])

  useEffect(() => {
    if (!external || !externalOk) return
    void chat.refreshExternalExec()
  }, [chat, external, externalOk, vault.agentMode, externalCommand])

  return (
    <div className="chat-panel" data-testid="chat-panel">
      <div className="chat-header">
        <IconButton
          icon={History}
          label={t('chat.history')}
          size="sm"
          iconSize={14}
          data-testid="chat-history"
          onClick={() => chat.showHistory()}
        />
        <span className="chat-title" data-testid="chat-title" title={title}>{title}</span>
        {chat.running ? (
          <IconButton
            icon={Square}
            label={t('chat.stop')}
            size="sm"
            iconSize={14}
            data-testid="chat-stop"
            onClick={() => chat.abort()}
          />
        ) : null}
        <IconButton
          icon={X}
          label={t('chat.close')}
          size="sm"
          iconSize={14}
          data-testid="chat-close"
          disabled={chat.running}
          onClick={() => { void chat.close() }}
        />
        <IconButton
          icon={Plus}
          label={t('chat.new')}
          size="sm"
          iconSize={14}
          className="chat-new"
          data-testid="chat-new"
          disabled={chat.running}
          onClick={() => chat.newSession()}
        />
      </div>
      {lockedModel ? (
        <p className="chat-notice" data-testid="chat-model-locked">
          {t('chat.modelLocked', { name: modelOptionLabel(lockedModel) })}
        </p>
      ) : null}
      <div className="chat-messages" data-testid="chat-messages">
        {session.messages.length === 0 ? (
          <EmptyState
            compact
            icon={MessageCircle}
            title={t('chat.emptyTitle')}
            body={t('chat.emptyBody')}
            testId="chat-empty"
          />
        ) : null}
        {session.messages.map((message, index) => (
          <div key={message.id ?? `${message.role}-${index}`} className={`chat-message is-${message.role}`}>
            <strong className="chat-message-role">{message.role === 'user' ? t('chat.user') : t('chat.assistant')}</strong>
            {message.role === 'assistant' && message.thinking ? (
              <details className="chat-thinking" data-testid="chat-thinking">
                <summary>{t('chat.thinking')}</summary>
                <ChatMarkdown text={message.thinking} />
              </details>
            ) : null}
            {message.role === 'assistant' && message.tools.length > 0 ? (
              <ChatTools tools={message.tools} />
            ) : null}
            {message.role === 'assistant' ? <ChatMarkdown text={message.text} /> : <p>{message.text}</p>}
            {message.role === 'assistant' && message.id && chat.undoableTurnIds.includes(message.id) ? (
              <div className="chat-undo">
                <Button
                  tone="secondary"
                  size="sm"
                  data-testid="chat-undo-turn"
                  disabled={chat.running}
                  onClick={() => { void chat.undoTurn(message.id!) }}
                >
                  {t('chat.undoTurn')}
                </Button>
                {chat.undoSkippedTurnIds.includes(message.id) ? (
                  <span className="chat-undo-skipped" data-testid="chat-undo-skipped">{t('chat.undoSkipped')}</span>
                ) : null}
              </div>
            ) : null}
          </div>
        ))}
      </div>
      {chat.error && (
        <p className="error" data-testid="chat-error" role="alert">
          {chatErrorText(chat.error, t, normalizeAgentMaxTurns(settings.form.agent?.maxTurns))}
        </p>
      )}
      <div className="chat-compose">
        <textarea
          className="chat-draft"
          data-testid="chat-draft"
          value={chat.draft}
          onChange={(event) => chat.setDraft(event.target.value)}
          placeholder={t('chat.placeholder')}
        />
        <div className="chat-compose-bar">
          {external ? (
            <div className="chat-model-empty">
              <p className="chat-model-empty" data-testid="chat-external-model">
                {externalOk ? t('chat.externalModel') : t('chat.externalUnavailable')}
              </p>
              {externalOk ? (
                <p data-testid="chat-external-exec" className="chat-model-empty">
                  {externalExecLabel}
                </p>
              ) : null}
            </div>
          ) : models.length > 0 && modelId ? (
            <Select
              className="chat-model"
              aria-label={t('chat.model')}
              data-testid="chat-model"
              value={modelId}
              options={models.map((config) => ({ value: config.id, label: modelOptionLabel(config) }))}
              onValueChange={(id) => chat.setModel(id)}
            />
          ) : (
            <p className="chat-model-empty" data-testid="chat-model-empty">{t('chat.noModel')}</p>
          )}
          <Select
            className="chat-mode-select"
            aria-label={t('chat.mode')}
            data-testid="chat-mode"
            value={vault.agentMode}
            options={[
              { value: 'safe', label: t('chat.safe'), testId: 'chat-mode-safe' },
              { value: 'power', label: t('chat.power'), testId: 'chat-mode-power' },
              { value: 'grok', label: t('chat.grok'), testId: 'chat-mode-grok', disabled: !externalOk },
              { value: 'claude', label: t('chat.claude'), testId: 'chat-mode-claude', disabled: !externalOk },
              { value: 'codex', label: t('chat.codex'), testId: 'chat-mode-codex', disabled: !externalOk },
            ]}
            onValueChange={(mode) => {
              if (!isAgentMode(mode)) return
              if (isExternalAgentMode(mode) && !chat.externalAgentsAvailable) return
              void vault.setAgentMode(mode)
            }}
          />
          <span className="chat-compose-spacer" />
          <Button
            size="sm"
            tone="primary"
            icon={<Mark icon={Send} size={14} />}
            data-testid="chat-send"
            disabled={chat.running || chat.externalSendBlocked}
            onClick={() => { void chat.send() }}
          >
            {t('chat.send')}
          </Button>
        </div>
      </div>
      {chat.storagePersistent === false ? (
        <p className="chat-degraded" data-testid="chat-degraded">{t('chat.notPersistent')}</p>
      ) : null}
      {chat.memoryBusy ? (
        <p className="chat-memory" data-testid="chat-memory-busy">
          <span>{t('chat.memoryBusy')}</span>
          <button
            type="button"
            className="chat-memory-cancel"
            data-testid="chat-memory-cancel"
            onClick={() => chat.cancelMemoryWork()}
          >
            {t('chat.memoryCancel')}
          </button>
        </p>
      ) : null}
      {chat.memoryError ? (
        <p className="chat-memory is-error" data-testid="chat-memory-error" role="status">
          {t('chat.memoryFailed')}
        </p>
      ) : null}
      <ChatHistory />
    </div>
  )
})
