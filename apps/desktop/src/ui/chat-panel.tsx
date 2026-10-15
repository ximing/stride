import { ChatCircle } from '@phosphor-icons/react'
import { observer, useService } from '@rabjs/react'
import { ChatService } from '../services/panels.service'
import { VaultService } from '../services/vault.service'
import { ChatMarkdown } from './chat-markdown'
import { EmptyState } from './empty-state'

export const ChatPanel = observer(function ChatPanel() {
  const chat = useService(ChatService)
  const vault = useService(VaultService)
  const session = chat.sessions.find((item) => item.id === chat.activeId) ?? chat.sessions[0]
  return (
    <div data-testid="chat-panel">
      <h2>Agent</h2>
      <div className="chat-tabs" data-testid="chat-tabs">
        {chat.sessions.map((item) => (
          <button
            key={item.id}
            type="button"
            aria-pressed={item.id === chat.activeId}
            onClick={() => chat.select(item.id)}
          >
            {item.title}
          </button>
        ))}
        <button type="button" data-testid="chat-new" onClick={() => chat.newSession()}>New</button>
      </div>
      <div className="chat-messages" data-testid="chat-messages">
        {session && session.messages.length === 0 ? (
          <EmptyState
            compact
            icon={ChatCircle}
            title="Ask the agent"
            body="Ask about the open note, or anything in your vault."
            testId="chat-empty"
          />
        ) : null}
        {session?.messages.map((message, index) => (
          <div key={`${message.role}-${index}`} className="chat-message">
            <strong>{message.role}</strong>
            {message.role === 'assistant' && message.thinking ? (
              <details className="chat-thinking" data-testid="chat-thinking">
                <summary>思考</summary>
                <ChatMarkdown text={message.thinking} />
              </details>
            ) : null}
            {message.role === 'assistant' && message.tools.map((tool) => (
              <div key={tool.id} className={tool.isError ? 'chat-tool is-error' : 'chat-tool'} data-testid="chat-tool">
                <span data-testid="chat-tool-name">{tool.name}</span>
                <span data-testid="chat-tool-args">{tool.argsSummary}</span>
                {tool.pending ? <span>running</span> : <span data-testid="chat-tool-result">{tool.resultSummary}</span>}
                {typeof tool.durationMs === 'number' ? <span data-testid="chat-tool-duration">{tool.durationMs} ms</span> : null}
              </div>
            ))}
            {message.role === 'assistant' ? <ChatMarkdown text={message.text} /> : <p>{message.text}</p>}
          </div>
        ))}
      </div>
      {chat.error && <p className="error" data-testid="chat-error" role="alert">{chat.error}</p>}
      <div className="chat-compose">
        <div className="chat-mode">
          <button type="button" data-testid="chat-mode-safe" aria-pressed={vault.agentMode === 'safe'} onClick={() => { void vault.setAgentMode('safe') }}>Safe</button>
          <button type="button" data-testid="chat-mode-power" aria-pressed={vault.agentMode === 'power'} onClick={() => { void vault.setAgentMode('power') }}>Power</button>
        </div>
        <textarea
          data-testid="chat-draft"
          value={chat.draft}
          onChange={(event) => chat.setDraft(event.target.value)}
          placeholder="Ask about the open note"
        />
        <button className="primary" type="button" data-testid="chat-send" disabled={chat.running} onClick={() => { void chat.send() }}>Send</button>
        <button type="button" data-testid="chat-abort" disabled={!chat.running} onClick={() => chat.abort()}>Stop</button>
      </div>
    </div>
  )
})
