import { MessageCircle, Plus, Send, Square } from 'lucide-react'
import { observer, useService } from '@rabjs/react'
import { ChatService } from '../services/panels.service'
import { VaultService } from '../services/vault.service'
import { ChatMarkdown } from './chat-markdown'
import { Button } from './button'
import { EmptyState } from './empty-state'
import { Mark } from './icon'
import { Tabs, TabsList, TabsTrigger } from './tabs'

export const ChatPanel = observer(function ChatPanel() {
  const chat = useService(ChatService)
  const vault = useService(VaultService)
  const session = chat.sessions.find((item) => item.id === chat.activeId) ?? chat.sessions[0]
  return (
    <div className="chat-panel" data-testid="chat-panel">
      <div className="chat-head">
        <h2 className="panel-heading">Agent</h2>
        <Button
          size="sm"
          tone="secondary"
          icon={<Mark icon={Plus} size={14} />}
          data-testid="chat-new"
          onClick={() => chat.newSession()}
        >
          New
        </Button>
      </div>
      <Tabs className="chat-session-tabs" value={chat.activeId} onValueChange={(id) => chat.select(id)}>
        <TabsList className="chat-tabs" data-testid="chat-tabs" aria-label="Agent sessions">
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
            title="Ask the agent"
            body="Ask about the open note, or anything in your vault."
            testId="chat-empty"
          />
        ) : null}
        {session?.messages.map((message, index) => (
          <div key={`${message.role}-${index}`} className={`chat-message is-${message.role}`}>
            <strong className="chat-message-role">{message.role}</strong>
            {message.role === 'assistant' && message.thinking ? (
              <details className="chat-thinking" data-testid="chat-thinking">
                <summary>思考</summary>
                <ChatMarkdown text={message.thinking} />
              </details>
            ) : null}
            {message.role === 'assistant' && message.tools.map((tool) => (
              <div key={tool.id} className={tool.isError ? 'chat-tool is-error' : 'chat-tool'} data-testid="chat-tool">
                <span className="chat-tool-name" data-testid="chat-tool-name">{tool.name}</span>
                <span className="chat-tool-args" data-testid="chat-tool-args">{tool.argsSummary}</span>
                {tool.pending ? <span className="chat-tool-status">running</span> : <span data-testid="chat-tool-result">{tool.resultSummary}</span>}
                {typeof tool.durationMs === 'number' ? <span className="chat-tool-duration" data-testid="chat-tool-duration">{tool.durationMs} ms</span> : null}
              </div>
            ))}
            {message.role === 'assistant' ? <ChatMarkdown text={message.text} /> : <p>{message.text}</p>}
          </div>
        ))}
      </div>
      {chat.error && <p className="error" data-testid="chat-error" role="alert">{chat.error}</p>}
      <div className="chat-compose">
        <Tabs
          className="chat-mode-tabs"
          value={vault.agentMode}
          onValueChange={(mode) => {
            if (mode === 'safe' || mode === 'power') void vault.setAgentMode(mode)
          }}
        >
          <TabsList className="chat-mode" aria-label="Agent mode">
            <TabsTrigger
              className="chat-mode-trigger"
              value="safe"
              data-testid="chat-mode-safe"
              aria-pressed={vault.agentMode === 'safe'}
            >
              Safe
            </TabsTrigger>
            <TabsTrigger
              className="chat-mode-trigger"
              value="power"
              data-testid="chat-mode-power"
              aria-pressed={vault.agentMode === 'power'}
            >
              Power
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <textarea
          className="chat-draft"
          data-testid="chat-draft"
          value={chat.draft}
          onChange={(event) => chat.setDraft(event.target.value)}
          placeholder="Ask about the open note"
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
            Send
          </Button>
          <Button
            size="sm"
            tone="secondary"
            icon={<Mark icon={Square} size={14} />}
            data-testid="chat-abort"
            disabled={!chat.running}
            onClick={() => chat.abort()}
          >
            Stop
          </Button>
        </div>
      </div>
    </div>
  )
})
