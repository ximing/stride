import { MessageCircle, Plus, Send, Square } from 'lucide-react'
import { observer, useService } from '@rabjs/react'
import { useTranslation } from 'react-i18next'
import { ChatService } from '../../services/chat/chat.service'
import { VaultService } from '../../services/vault/vault.service'
import { ChatMarkdown } from './chat-markdown'
import { Button } from '../primitives/button'
import { EmptyState } from '../primitives/empty-state'
import { Mark } from '../primitives/icon'
import { Tabs, TabsList, TabsTrigger } from '../primitives/tabs'

export const ChatPanel = observer(function ChatPanel() {
  const { t } = useTranslation()
  const chat = useService(ChatService)
  const vault = useService(VaultService)
  const session = chat.sessions.find((item) => item.id === chat.activeId) ?? chat.sessions[0]
  return (
    <div className="chat-panel" data-testid="chat-panel">
      <div className="chat-head">
        <h2 className="panel-heading">{t('chat.heading')}</h2>
        <Button
          size="sm"
          tone="quiet"
          icon={<Mark icon={Plus} size={14} />}
          data-testid="chat-new"
          onClick={() => chat.newSession()}
        >
          {t('chat.new')}
        </Button>
      </div>
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
          {chat.error === 'Add a model provider, base URL, model, and key in Settings' ? t('chat.needProvider') : chat.error}
        </p>
      )}
      <div className="chat-compose">
        <Tabs
          className="chat-mode-tabs"
          value={vault.agentMode}
          onValueChange={(mode) => {
            if (mode === 'safe' || mode === 'power') void vault.setAgentMode(mode)
          }}
        >
          <TabsList className="chat-mode" aria-label={t('chat.mode')}>
            <TabsTrigger
              className="chat-mode-trigger"
              value="safe"
              data-testid="chat-mode-safe"
              aria-pressed={vault.agentMode === 'safe'}
            >
              {t('chat.safe')}
            </TabsTrigger>
            <TabsTrigger
              className="chat-mode-trigger"
              value="power"
              data-testid="chat-mode-power"
              aria-pressed={vault.agentMode === 'power'}
            >
              {t('chat.power')}
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <textarea
          className="chat-draft"
          data-testid="chat-draft"
          value={chat.draft}
          onChange={(event) => chat.setDraft(event.target.value)}
          placeholder={t('chat.placeholder')}
        />
        <div className="chat-compose-actions">
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
          <Button
            size="sm"
            tone="quiet"
            icon={<Mark icon={Square} size={14} />}
            data-testid="chat-abort"
            disabled={!chat.running}
            onClick={() => chat.abort()}
          >
            {t('chat.stop')}
          </Button>
        </div>
      </div>
    </div>
  )
})
