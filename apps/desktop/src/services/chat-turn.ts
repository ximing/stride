import type { StreamFn } from '@earendil-works/pi-agent-core'
import type { Api, Model } from '@earendil-works/pi-ai'
import { runAgentLoop } from '@stride/core'

export interface ChatMessage {
  role: 'user' | 'assistant'
  text: string
  thinking: string
}

export interface ChatSession {
  id: string
  title: string
  messages: ChatMessage[]
}

export function appendAssistantDelta(
  sessions: ChatSession[],
  sessionId: string,
  kind: 'text' | 'thinking',
  delta: string,
) {
  const session = sessions.find((item) => item.id === sessionId)
  const message = session?.messages[session.messages.length - 1]
  if (!message || message.role !== 'assistant') return
  if (kind === 'text') message.text += delta
  else message.thinking += delta
}

export async function playChatTurn(input: {
  model: Model<Api>
  apiKey: string
  systemPrompt: string
  prompt: string
  signal?: AbortSignal
  streamFn: StreamFn
  onText: (delta: string) => void
  onThinking: (delta: string) => void
}): Promise<{ text: string; aborted: boolean }> {
  return runAgentLoop({
    model: input.model,
    apiKey: input.apiKey,
    systemPrompt: input.systemPrompt,
    prompt: input.prompt,
    tools: [],
    maxTurns: 8,
    signal: input.signal,
    streamFn: input.streamFn,
    onEvent: (event) => {
      if (event.type === 'text_delta') input.onText(event.delta)
      else if (event.type === 'thinking_delta') input.onThinking(event.delta)
    },
  })
}
