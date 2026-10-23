import { MessageCircle, Plus, Send, Square } from 'lucide-react'
import type { PublicLlmConfig } from '@stride/core'
import { observer, useService } from '@rabjs/react'
import { useTranslation } from 'react-i18next'
import { CHAT_TURN_LIMIT_ERROR, ChatService } from '../../services/chat/chat.service'
import { SettingsService } from '../../services/settings/settings.service'
import { VaultService } from '../../services/vault/vault.service'
import { ChatMarkdown } from './chat-markdown'
import { Button, IconButton } from '../primitives/button'
import { EmptyState } from '../primitives/empty-state'
import { Mark } from '../primitives/icon'
import { Select } from '../primitives/select'
import { Tabs, TabsList, TabsTrigger } from '../primitives/tabs'

function chatErrorText(error: string, translate: (key: string) => string): string {
  if (error === 'Add a model provider, base URL, model, and key in Settings') return translate('chat.needProvider')
  if (error === CHAT_TURN_LIMIT_ERROR) return translate('chat.turnLimit')
  return error
}

function modelOptionLabel(config: PublicLlmConfig): string {
  const name = config.name.trim()
  const model = config.model.trim()
  if (name && model && name !== model) return `${name} · ${model}`
  return model || name || config.provider || config.id
}

export const ChatPanel = observer(function ChatPanel() {
  const { t } = useTranslation()
  const chat = useService(ChatService)
  const settings = useService(SettingsService)
  const vault = useService(VaultService)
  const session = chat.sessions.find((item) => item.id === chat.activeId) ?? chat.sessions[0]
  const models = settings.form.llmConfigs
  const modelId = chat.activeModelId
  return (
    <div className="chat-panel" data-testid="chat-panel">
      <div className="chat-sessions">
        <Tabs className="chat-session-tabs" value={chat.activeId} onValueChange={(id) => chat.select(id)}>
          <TabsList className="chat-tabs" data-testid="chat-tabs" aria-label={t('chat.sessions')}>
            {chat.sessions.map((item) => (
              <TabsTrigger
                key={item.id}
                className="chat-tab"
                value={item.id}
                aria-pressed={item.id === chat.activeId}
              >
                {item.title}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <IconButton
          icon={Plus}
          label={t('chat.new')}
          size="sm"
          iconSize={14}
          className="chat-new"
          data-testid="chat-new"
          onClick={() => chat.newSession()}
        />
      </div>
      <div className="chat-messages" data-testid="chat-messages">
        {session && session.messages.length === 0 ? (
          <EmptyState
            compact
            icon={MessageCircle}
            title={t('chat.emptyTitle')}
            body={t('chat.emptyBody')}
            testId="chat-empty"
          />
        ) : null}
        {session?.messages.map((message, index) => (
          <div key={`${message.role}-${index}`} className={`chat-message is-${message.role}`}>
            <strong className="chat-message-role">{message.role === 'user' ? t('chat.user') : t('chat.assistant')}</strong>
            {message.role === 'assistant' && message.thinking ? (
              <details className="chat-thinking" data-testid="chat-thinking">
                <summary>{t('chat.thinking')}</summary>
                <ChatMarkdown text={message.thinking} />
              </details>
            ) : null}
            {message.role === 'assistant' && message.tools.map((tool) => (
              <div key={tool.id} className={tool.isError ? 'chat-tool is-error' : 'chat-tool'} data-testid="chat-tool">
                <span className="chat-tool-name" data-testid="chat-tool-name">{tool.name}</span>
                <span className="chat-tool-args" data-testid="chat-tool-args">{tool.argsSummary}</span>
                {tool.pending ? <span className="chat-tool-status">{t('chat.running')}</span> : <span data-testid="chat-tool-result">{tool.resultSummary}</span>}
                {typeof tool.durationMs === 'number' ? <span className="chat-tool-duration" data-testid="chat-tool-duration">{t('chat.duration', { ms: tool.durationMs })}</span> : null}
              </div>
            ))}
            {message.role === 'assistant' ? <ChatMarkdown text={message.text} /> : <p>{message.text}</p>}
          </div>
        ))}
      </div>
      {chat.error && (
        <p className="error" data-testid="chat-error" role="alert">
          {chatErrorText(chat.error, t)}
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
          {models.length > 0 && modelId ? (
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
            ]}
            onValueChange={(mode) => {
              if (mode === 'safe' || mode === 'power') void vault.setAgentMode(mode)
            }}
          />
          <span className="chat-compose-spacer" />
          {chat.running ? (
            <Button
              size="sm"
              tone="quiet"
              icon={<Mark icon={Square} size={14} />}
              data-testid="chat-abort"
              onClick={() => chat.abort()}
            >
              {t('chat.stop')}
            </Button>
          ) : null}
          <Button
            size="sm"
            tone="primary"
            icon={<Mark icon={Send} size={14} />}
            data-testid="chat-send"
            disabled={chat.running}
            onClick={() => { void chat.send() }}
          >
            {t('chat.send')}
          </Button>
        </div>
      </div>
    </div>
  )
})
