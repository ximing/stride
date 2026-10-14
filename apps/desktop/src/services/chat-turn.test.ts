import { createAssistantMessageEventStream } from '../../../../packages/core/node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js'
import type { AssistantMessage, Model, StopReason } from '@earendil-works/pi-ai'
import type { StreamFn } from '@earendil-works/pi-agent-core'
import { has, register, resolve } from '@rabjs/react'
import { describe, expect, it } from 'vitest'
import { ChatService, SettingsService } from './panels.service'
import { appendAssistantDelta, playChatTurn, type ChatSession } from './chat-turn'

const usage = {
  input: 3,
  output: 2,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 5,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

const model = {
  id: 'gpt-4o-mini',
  name: 'gpt-4o-mini',
  api: 'openai-completions',
  provider: 'openai',
  baseUrl: 'https://example.test/v1',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 4096,
} as Model<'openai-completions'>

function assistant(text: string, stopReason: StopReason = 'stop'): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'openai-completions',
    provider: 'openai',
    model: 'gpt-4o-mini',
    stopReason,
    timestamp: Date.now(),
    usage,
  }
}

describe('playChatTurn', () => {
  it('appends text and thinking deltas', async () => {
    let text = ''
    let thinking = ''
    const streamFn: StreamFn = () => {
      const stream = createAssistantMessageEventStream()
      queueMicrotask(() => {
        const done = assistant('hello')
        stream.push({ type: 'start', partial: assistant('') })
        stream.push({ type: 'thinking_delta', contentIndex: 0, delta: 'hmm', partial: assistant('') })
        stream.push({ type: 'text_delta', contentIndex: 0, delta: 'hel', partial: assistant('hel') })
        stream.push({ type: 'text_delta', contentIndex: 0, delta: 'lo', partial: done })
        stream.push({ type: 'done', reason: 'stop', message: done })
        stream.end(done)
      })
      return stream
    }
    const result = await playChatTurn({
      model,
      apiKey: 'sk-passed',
      systemPrompt: 'test',
      prompt: 'go',
      streamFn,
      onText: (delta) => { text += delta },
      onThinking: (delta) => { thinking += delta },
    })
    expect(text).toBe('hello')
    expect(thinking).toBe('hmm')
    expect(result.text).toBe('hello')
    expect(result.aborted).toBe(false)
  })

  it('aborts on the first text delta', async () => {
    const controller = new AbortController()
    let calls = 0
    const streamFn: StreamFn = () => {
      calls += 1
      const stream = createAssistantMessageEventStream()
      queueMicrotask(() => {
        void (async () => {
          try {
            stream.push({ type: 'start', partial: assistant('') })
            stream.push({ type: 'text_delta', contentIndex: 0, delta: 'hel', partial: assistant('hel') })
            await new Promise((resolveDelay) => setTimeout(resolveDelay, 40))
            if (controller.signal.aborted) {
              const error = assistant('', 'aborted')
              stream.push({ type: 'error', reason: 'aborted', error })
              stream.end(error)
              return
            }
            const done = assistant('hello')
            stream.push({ type: 'done', reason: 'stop', message: done })
            stream.end(done)
          } catch {
            // Abort can close the stream.
          }
        })()
      })
      return stream
    }
    const result = await playChatTurn({
      model,
      apiKey: 'sk-passed',
      systemPrompt: 'test',
      prompt: 'go',
      signal: controller.signal,
      streamFn,
      onText: () => controller.abort(),
      onThinking: () => {},
    })
    expect(calls).toBe(1)
    expect(result.aborted).toBe(true)
  })

  it('writes deltas only into the session that started the turn', () => {
    const sessions: ChatSession[] = [
      { id: 'a', title: 'A', messages: [{ role: 'assistant', text: '', thinking: '' }] },
      { id: 'b', title: 'B', messages: [] },
    ]
    appendAssistantDelta(sessions, 'a', 'text', 'hello')
    appendAssistantDelta(sessions, 'a', 'thinking', 'hmm')
    expect(sessions[0]?.messages[0]).toEqual({ role: 'assistant', text: 'hello', thinking: 'hmm' })
    expect(sessions[1]?.messages).toEqual([])
  })

  it('does not call the model when no key is configured', async () => {
    if (!has(SettingsService)) register(SettingsService)
    if (!has(ChatService)) register(ChatService)
    const chat = resolve(ChatService)
    chat.draft = 'hello'
    chat.error = ''
    await chat.send()
    expect(chat.error).toContain('Settings')
    expect(chat.sessions[0]?.messages).toEqual([])
  })
})
